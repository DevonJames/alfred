/**
 * Alfred Apple on-device STT helper (macOS Speech framework).
 *
 * Reads mono PCM s16le from stdin, writes JSONL turn events to stdout.
 *
 * Env:
 *   ALFRED_APPLE_STT_SAMPLE_RATE  (default 16000)
 *   ALFRED_APPLE_STT_LOCALE       (default en-US)
 *   ALFRED_APPLE_STT_ON_DEVICE    (default 1)
 */
import Foundation
import Speech
import AVFoundation

struct OutEvent: Encodable {
  let type: String
  var text: String? = nil
  var error: String? = nil
  var failureClass: String? = nil
}

func emit(_ event: OutEvent) {
  guard let data = try? JSONEncoder().encode(event),
        let line = String(data: data, encoding: .utf8) else { return }
  fputs(line + "\n", stdout)
  fflush(stdout)
}

func failAndExit(_ message: String, failureClass: String = "unavailable") -> Never {
  emit(OutEvent(type: "error", error: message, failureClass: failureClass))
  exit(1)
}

let sampleRate = Double(ProcessInfo.processInfo.environment["ALFRED_APPLE_STT_SAMPLE_RATE"] ?? "16000") ?? 16000
let localeId = ProcessInfo.processInfo.environment["ALFRED_APPLE_STT_LOCALE"] ?? "en-US"
let onDevice = (ProcessInfo.processInfo.environment["ALFRED_APPLE_STT_ON_DEVICE"] ?? "1") != "0"

guard #available(macOS 10.15, *) else {
  failAndExit("macOS 10.15+ required for Speech framework")
}

let locale = Locale(identifier: localeId)
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
  failAndExit("SFSpeechRecognizer unavailable for locale \(localeId)")
}

if onDevice && !recognizer.supportsOnDeviceRecognition {
  fputs("[apple-stt] warning: on-device recognition not supported for locale; using network Speech\n", stderr)
}

let authLock = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizerAuthorizationStatus.notDetermined
SFSpeechRecognizer.requestAuthorization { status in
  authStatus = status
  authLock.signal()
}
_ = authLock.wait(timeout: .now() + 60)

switch authStatus {
case .authorized:
  break
case .denied:
  failAndExit(
    "Speech recognition permission denied — System Settings → Privacy & Security → Speech Recognition",
    failureClass: "auth",
  )
case .restricted:
  failAndExit("Speech recognition restricted on this Mac", failureClass: "auth")
case .notDetermined:
  failAndExit("Speech recognition authorization not determined", failureClass: "auth")
@unknown default:
  failAndExit("Speech recognition authorization failed", failureClass: "auth")
}

guard let audioFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16,
  sampleRate: sampleRate,
  channels: 1,
  interleaved: true
) else {
  failAndExit("Failed to create AVAudioFormat")
}

final class Session {
  let recognizer: SFSpeechRecognizer
  let format: AVAudioFormat
  let onDevice: Bool
  let lock = NSLock()
  var request: SFSpeechAudioBufferRecognitionRequest?
  var task: SFSpeechRecognitionTask?
  var startedTurn = false
  var closed = false
  let workQueue = DispatchQueue(label: "alfred.apple-stt")

  init(recognizer: SFSpeechRecognizer, format: AVAudioFormat, onDevice: Bool) {
    self.recognizer = recognizer
    self.format = format
    self.onDevice = onDevice
  }

  func startTask() {
    lock.lock()
    guard !closed else {
      lock.unlock()
      return
    }
    task?.cancel()
    task = nil
    request?.endAudio()

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    if #available(macOS 13, *) {
      req.addsPunctuation = true
    }
    if onDevice && recognizer.supportsOnDeviceRecognition {
      req.requiresOnDeviceRecognition = true
    }
    request = req
    startedTurn = false
    lock.unlock()

    let newTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
      self?.workQueue.async {
        self?.onRecognition(result: result, error: error)
      }
    }
    lock.lock()
    task = newTask
    lock.unlock()
  }

  private func onRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
    lock.lock()
    let isClosed = closed
    lock.unlock()
    if isClosed { return }

    if let error {
      let ns = error as NSError
      if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 216 || ns.code == 203) {
        return
      }
      let msg = ns.localizedDescription.lowercased()
      if msg.contains("cancel") { return }
      emit(OutEvent(type: "error", error: ns.localizedDescription, failureClass: "upstream_5xx"))
      return
    }
    guard let result else { return }
    let text = result.bestTranscription.formattedString
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }

    lock.lock()
    let first = !startedTurn
    if first { startedTurn = true }
    lock.unlock()

    if first {
      emit(OutEvent(type: "start_of_turn", text: text))
    }
    emit(OutEvent(type: "partial_transcript", text: text))

    if result.isFinal {
      emit(OutEvent(type: "eager_end_of_turn", text: text))
      emit(OutEvent(type: "end_of_turn", text: text))
      workQueue.async { [weak self] in
        self?.startTask()
      }
    }
  }

  func appendPCM(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, let request else { return }
    let frameCount = data.count / MemoryLayout<Int16>.size
    guard frameCount > 0 else { return }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount))
    else { return }
    buffer.frameLength = AVAudioFrameCount(frameCount)
    data.withUnsafeBytes { raw in
      guard let src = raw.bindMemory(to: Int16.self).baseAddress,
            let dst = buffer.int16ChannelData?[0] else { return }
      dst.update(from: src, count: frameCount)
    }
    request.append(buffer)
  }

  func close() {
    lock.lock()
    closed = true
    request?.endAudio()
    task?.finish()
    task?.cancel()
    task = nil
    request = nil
    lock.unlock()
  }
}

let session = Session(recognizer: recognizer, format: audioFormat, onDevice: onDevice)
session.startTask()
emit(OutEvent(type: "ready"))

let stdinHandle = FileHandle.standardInput
while true {
  let chunk = stdinHandle.readData(ofLength: 4096)
  if chunk.isEmpty { break }
  session.appendPCM(chunk)
}

session.close()
exit(0)
