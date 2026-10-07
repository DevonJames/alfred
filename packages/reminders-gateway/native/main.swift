import AppKit
import EventKit
import Foundation

struct HelperRequest: Codable {
  var op: String
  var policyPath: String?
  var listId: String?
  var reminderId: String?
  var title: String?
  var notes: String?
  var due: String?
}

struct Grant: Codable {
  var access: String
  var title: String?
  var sourceIdentifier: String?
  var sourceTitle: String?
}

struct PolicyFile: Codable {
  var version: Int?
  var lists: [String: Grant]?
}

struct HelperError: Codable {
  var ok: Bool = false
  var error: String
  var message: String
}

let store = EKEventStore()
let encoder: JSONEncoder = {
  let encoder = JSONEncoder()
  encoder.dateEncodingStrategy = .iso8601
  encoder.outputFormatting = [.sortedKeys]
  return encoder
}()

func emit(_ value: some Encodable) -> Never {
  let data = (try? encoder.encode(value)) ?? Data("{\"ok\":false,\"error\":\"encode\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(HelperError(error: code, message: message))
}

func readRequest() -> HelperRequest {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty, let request = try? JSONDecoder().decode(HelperRequest.self, from: data) else {
    fail("bad_request", "Reminders helper expected a JSON request on stdin.")
  }
  return request
}

func hexColor(_ color: CGColor?) -> String? {
  guard let color else { return nil }
  let converted = color.converted(to: CGColorSpaceCreateDeviceRGB(), intent: .defaultIntent, options: nil) ?? color
  guard let comps = converted.components, comps.count >= 3 else { return nil }
  let r = Int((comps[0] * 255).rounded())
  let g = Int((comps[1] * 255).rounded())
  let b = Int((comps[2] * 255).rounded())
  return String(format: "#%02X%02X%02X", r, g, b)
}

func sourceTypeName(_ type: EKSourceType) -> String {
  switch type {
  case .local: return "local"
  case .exchange: return "exchange"
  case .calDAV: return "calDAV"
  case .mobileMe: return "mobileMe"
  case .subscribed: return "subscribed"
  case .birthdays: return "birthdays"
  default: return "other"
  }
}

func loadPolicy(_ path: String?) -> PolicyFile {
  guard let path, !path.isEmpty, let data = FileManager.default.contents(atPath: path) else {
    return PolicyFile(version: 1, lists: [:])
  }
  return (try? JSONDecoder().decode(PolicyFile.self, from: data)) ?? PolicyFile(version: 1, lists: [:])
}

func access(for list: EKCalendar, policy: PolicyFile) -> String {
  let grants = policy.lists ?? [:]
  if let grant = grants[list.calendarIdentifier] {
    return grant.access
  }
  let sourceId = list.source.sourceIdentifier
  let title = list.title
  for grant in grants.values {
    if grant.title == title && grant.sourceIdentifier == sourceId {
      return grant.access
    }
  }
  return "none"
}

func canRead(_ list: EKCalendar, policy: PolicyFile) -> Bool {
  let level = access(for: list, policy: policy)
  return level == "read" || level == "write"
}

func canWrite(_ list: EKCalendar, policy: PolicyFile) -> Bool {
  return access(for: list, policy: policy) == "write" && list.allowsContentModifications
}

func listById(_ id: String, policy: PolicyFile) -> EKCalendar? {
  store.calendars(for: .reminder).first { $0.calendarIdentifier == id && canWrite($0, policy: policy) }
}

struct CatalogList: Codable {
  var id: String
  var title: String
  var color: String?
  var writable: Bool
  var sourceIdentifier: String
  var sourceTitle: String
  var sourceType: String
}

struct CatalogResult: Codable {
  var ok: Bool = true
  var lists: [CatalogList]
}

struct ReminderOut: Codable {
  var id: String
  var title: String
  var notes: String?
  var due: String?
  var listId: String
  var listTitle: String
  var completed: Bool
}

struct RemindersResult: Codable {
  var ok: Bool = true
  var reminders: [ReminderOut]
}

struct ReminderResult: Codable {
  var ok: Bool = true
  var reminder: ReminderOut
}

func dueString(_ reminder: EKReminder) -> String? {
  guard let parts = reminder.dueDateComponents else { return nil }
  let hasTime = parts.hour != nil
  if hasTime, let date = Calendar.current.date(from: parts) {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }
  guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
  return String(format: "%04d-%02d-%02d", year, month, day)
}

func reminderOut(_ reminder: EKReminder) -> ReminderOut {
  ReminderOut(
    id: reminder.calendarItemIdentifier,
    title: reminder.title ?? "(untitled)",
    notes: reminder.notes,
    due: dueString(reminder),
    listId: reminder.calendar.calendarIdentifier,
    listTitle: reminder.calendar.title,
    completed: reminder.isCompleted
  )
}

func authorize() {
  let status = EKEventStore.authorizationStatus(for: .reminder)
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return }
  } else if status == .authorized {
    return
  }
  if status == .denied || status == .restricted {
    fail(
      "reminders_permission_denied",
      "Reminders access is off for Alfred Reminders. In System Settings → Privacy & Security → Reminders, allow Alfred Reminders. The node and Terminal switches do not cover it."
    )
  }

  let prompting = CommandLine.arguments.contains("--prompt")
  let app = NSApplication.shared
  if prompting {
    app.setActivationPolicy(.regular)
    if !app.isRunning {
      app.finishLaunching()
    }
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 96),
      styleMask: [.titled],
      backing: .buffered,
      defer: false
    )
    window.title = "Alfred Reminders"
    window.center()
    window.level = .floating
    let label = NSTextField(labelWithString: "Allow Alfred Reminders when macOS asks.")
    label.frame = NSRect(x: 20, y: 32, width: 400, height: 28)
    window.contentView?.addSubview(label)
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
  } else {
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
  }

  let started = Date()
  var granted = false
  var finished = false
  var message = "macOS did not grant Reminders access to Alfred Reminders."
  if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, error in
      granted = ok
      if let error { message = error.localizedDescription }
      finished = true
      CFRunLoopStop(CFRunLoopGetMain())
    }
  } else {
    store.requestAccess(to: .reminder) { ok, error in
      granted = ok
      if let error { message = error.localizedDescription }
      finished = true
      CFRunLoopStop(CFRunLoopGetMain())
    }
  }
  while !finished && Date().timeIntervalSince(started) < 110 {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
  }
  if !finished {
    fail("timeout", "Timed out waiting for Reminders permission.")
  }
  if !granted {
    fail("reminders_permission_denied", message)
  }
}

func catalog() -> Never {
  let lists = store.calendars(for: .reminder).map { list in
    CatalogList(
      id: list.calendarIdentifier,
      title: list.title,
      color: hexColor(list.cgColor),
      writable: list.allowsContentModifications,
      sourceIdentifier: list.source.sourceIdentifier,
      sourceTitle: list.source.title,
      sourceType: sourceTypeName(list.source.sourceType)
    )
  }
  emit(CatalogResult(lists: lists))
}

func fetchIncomplete(_ lists: [EKCalendar]) -> [EKReminder] {
  let predicate = store.predicateForIncompleteReminders(
    withDueDateStarting: nil,
    ending: nil,
    calendars: lists
  )
  var result: [EKReminder] = []
  var finished = false
  store.fetchReminders(matching: predicate) { reminders in
    result = reminders ?? []
    finished = true
  }
  let started = Date()
  while !finished && Date().timeIntervalSince(started) < 20 {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  if !finished {
    fail("timeout", "Timed out reading reminders.")
  }
  return result
}

func items(_ request: HelperRequest) -> Never {
  let policy = loadPolicy(request.policyPath)
  let lists = store.calendars(for: .reminder).filter { canRead($0, policy: policy) }
  if lists.isEmpty {
    emit(RemindersResult(reminders: []))
  }
  let reminders = fetchIncomplete(lists).prefix(200).map(reminderOut)
  emit(RemindersResult(reminders: Array(reminders)))
}

func dueComponents(_ value: String) -> DateComponents? {
  if value.count == 10 {
    let parts = value.split(separator: "-")
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
      return nil
    }
    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    return components
  }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let basic = ISO8601DateFormatter()
  basic.formatOptions = [.withInternetDateTime]
  guard let date = fractional.date(from: value) ?? basic.date(from: value) else { return nil }
  return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
}

func create(_ request: HelperRequest) -> Never {
  let policy = loadPolicy(request.policyPath)
  guard let listId = request.listId, let list = listById(listId, policy: policy) else {
    fail("list_denied", "That reminder list is not writable.")
  }
  let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if title.isEmpty {
    fail("bad_request", "A reminder needs a title.")
  }
  let reminder = EKReminder(eventStore: store)
  reminder.calendar = list
  reminder.title = title
  if let notes = request.notes, !notes.isEmpty {
    reminder.notes = notes
  }
  if let due = request.due, !due.isEmpty {
    reminder.dueDateComponents = dueComponents(due)
  }
  do {
    try store.save(reminder, commit: true)
  } catch {
    fail("save_failed", error.localizedDescription)
  }
  emit(ReminderResult(reminder: reminderOut(reminder)))
}

func setDue(_ request: HelperRequest) -> Never {
  let policy = loadPolicy(request.policyPath)
  guard let reminderId = request.reminderId, !reminderId.isEmpty else {
    fail("bad_request", "Changing a due date needs the reminder id.")
  }
  guard let item = store.calendarItem(withIdentifier: reminderId) as? EKReminder else {
    fail("not_found", "That reminder is no longer on this Mac.")
  }
  if !canWrite(item.calendar, policy: policy) {
    fail("list_denied", "That reminder list is not writable.")
  }
  if let due = request.due, !due.isEmpty {
    guard let components = dueComponents(due) else {
      fail("bad_request", "That day is not a date.")
    }
    item.dueDateComponents = components
  } else {
    item.dueDateComponents = nil
  }
  do {
    try store.save(item, commit: true)
  } catch {
    fail("save_failed", error.localizedDescription)
  }
  emit(ReminderResult(reminder: reminderOut(item)))
}

func complete(_ request: HelperRequest) -> Never {
  let policy = loadPolicy(request.policyPath)
  guard let reminderId = request.reminderId, !reminderId.isEmpty else {
    fail("bad_request", "Completing a reminder needs its id.")
  }
  guard let item = store.calendarItem(withIdentifier: reminderId) as? EKReminder else {
    fail("not_found", "That reminder is no longer on this Mac.")
  }
  if !canWrite(item.calendar, policy: policy) {
    fail("list_denied", "That reminder list is not writable.")
  }
  item.isCompleted = true
  item.completionDate = Date()
  do {
    try store.save(item, commit: true)
  } catch {
    fail("save_failed", error.localizedDescription)
  }
  emit(ReminderResult(reminder: reminderOut(item)))
}

if CommandLine.arguments.contains("--prompt") {
  authorize()
  catalog()
}
let request = readRequest()
authorize()
switch request.op {
case "lists": catalog()
case "items": items(request)
case "create": create(request)
case "due": setDue(request)
case "complete": complete(request)
default: fail("bad_op", "Unknown reminders op \(request.op).")
}
