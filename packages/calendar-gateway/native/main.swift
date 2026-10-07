import AppKit
import EventKit
import Foundation

struct HelperRequest: Codable {
  var op: String
  var start: String?
  var end: String?
  var calendarId: String?
  var eventId: String?
  var title: String?
  var notes: String?
  var location: String?
  var policyPath: String?
}

struct Grant: Codable {
  var access: String
  var title: String?
  var sourceIdentifier: String?
  var sourceTitle: String?
}

struct PolicyFile: Codable {
  var version: Int?
  var calendars: [String: Grant]?
}

struct HelperError: Codable {
  var ok: Bool = false
  var error: String
  var message: String
}

struct OkResult: Codable {
  var ok: Bool = true
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
    fail("bad_request", "Calendar helper expected a JSON request on stdin.")
  }
  return request
}

func parseDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = fractional.date(from: value) { return date }
  let basic = ISO8601DateFormatter()
  basic.formatOptions = [.withInternetDateTime]
  return basic.date(from: value)
}

func iso(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.string(from: date)
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
    return PolicyFile(version: 1, calendars: [:])
  }
  return (try? JSONDecoder().decode(PolicyFile.self, from: data)) ?? PolicyFile(version: 1, calendars: [:])
}

func access(for calendar: EKCalendar, policy: PolicyFile) -> String {
  let grants = policy.calendars ?? [:]
  if let grant = grants[calendar.calendarIdentifier] {
    return grant.access
  }
  let sourceId = calendar.source.sourceIdentifier
  let title = calendar.title
  for grant in grants.values {
    if grant.title == title && grant.sourceIdentifier == sourceId {
      return grant.access
    }
  }
  return "none"
}

func canRead(_ calendar: EKCalendar, policy: PolicyFile) -> Bool {
  let level = access(for: calendar, policy: policy)
  return level == "read" || level == "write"
}

func canWrite(_ calendar: EKCalendar, policy: PolicyFile) -> Bool {
  return access(for: calendar, policy: policy) == "write" && calendar.allowsContentModifications
}

struct CatalogCalendar: Codable {
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
  var calendars: [CatalogCalendar]
}

struct EventOut: Codable {
  var id: String
  var title: String
  var start: String
  var end: String
  var allDay: Bool
  var calendarId: String
  var calendarTitle: String
  var sourceTitle: String
  var location: String?
}

struct EventsResult: Codable {
  var ok: Bool = true
  var events: [EventOut]
}

struct EventResult: Codable {
  var ok: Bool = true
  var event: EventOut
}

func eventOut(_ event: EKEvent) -> EventOut {
  EventOut(
    id: event.eventIdentifier ?? "",
    title: event.title ?? "(untitled)",
    start: iso(event.startDate),
    end: iso(event.endDate),
    allDay: event.isAllDay,
    calendarId: event.calendar.calendarIdentifier,
    calendarTitle: event.calendar.title,
    sourceTitle: event.calendar.source.title,
    location: event.location
  )
}

func authorize() {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return }
  } else if status == .authorized {
    return
  }
  if status != .notDetermined {
    fail(
      "calendar_permission_denied",
      "Calendar access is off for Alfred Calendar. Allow it in System Settings → Privacy & Security → Calendars."
    )
  }

  NSApplication.shared.setActivationPolicy(.accessory)
  NSApplication.shared.activate(ignoringOtherApps: true)

  let started = Date()
  var granted = false
  var finished = false
  var message = "Calendar access was not granted."
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, error in
      granted = ok
      if let error { message = error.localizedDescription }
      finished = true
    }
  } else {
    store.requestAccess(to: .event) { ok, error in
      granted = ok
      if let error { message = error.localizedDescription }
      finished = true
    }
  }
  while !finished && Date().timeIntervalSince(started) < 110 {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }
  if !finished {
    fail("timeout", "Timed out waiting for Calendar permission.")
  }
  if !granted {
    fail("calendar_permission_denied", message)
  }
}

func catalog() -> Never {
  let calendars = store.calendars(for: .event).map { calendar in
    CatalogCalendar(
      id: calendar.calendarIdentifier,
      title: calendar.title,
      color: hexColor(calendar.cgColor),
      writable: calendar.allowsContentModifications,
      sourceIdentifier: calendar.source.sourceIdentifier,
      sourceTitle: calendar.source.title,
      sourceType: sourceTypeName(calendar.source.sourceType)
    )
  }
  emit(CatalogResult(calendars: calendars))
}

func events(_ request: HelperRequest) -> Never {
  guard let start = parseDate(request.start), let end = parseDate(request.end) else {
    fail("bad_range", "Listing events needs a start and end.")
  }
  let policy = loadPolicy(request.policyPath)
  var calendars = store.calendars(for: .event).filter { canRead($0, policy: policy) }
  if let calendarId = request.calendarId, !calendarId.isEmpty {
    calendars = calendars.filter { $0.calendarIdentifier == calendarId }
  }
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
  let found = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
  emit(EventsResult(events: found.map(eventOut)))
}

func calendar(id: String, policy: PolicyFile) -> EKCalendar? {
  guard let calendar = store.calendar(withIdentifier: id) else { return nil }
  return canWrite(calendar, policy: policy) ? calendar : nil
}

func create(_ request: HelperRequest) -> Never {
  guard let calendarId = request.calendarId, let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines),
        !title.isEmpty, let start = parseDate(request.start), let end = parseDate(request.end) else {
    fail("bad_request", "Creating an event needs a calendar, title, start, and end.")
  }
  let policy = loadPolicy(request.policyPath)
  guard let calendar = calendar(id: calendarId, policy: policy) else {
    fail("calendar_denied", "That calendar is not open for writes.")
  }
  let event = EKEvent(eventStore: store)
  event.calendar = calendar
  event.title = title
  event.startDate = start
  event.endDate = end
  event.notes = request.notes
  event.location = request.location
  do {
    try store.save(event, span: .thisEvent, commit: true)
  } catch {
    fail("eventkit", error.localizedDescription)
  }
  emit(EventResult(event: eventOut(event)))
}

func existingEvent(_ id: String, policy: PolicyFile) -> EKEvent? {
  guard let event = store.event(withIdentifier: id) else { return nil }
  return canWrite(event.calendar, policy: policy) ? event : nil
}

func update(_ request: HelperRequest) -> Never {
  guard let eventId = request.eventId, let start = parseDate(request.start), let end = parseDate(request.end) else {
    fail("bad_request", "Updating an event needs an id, start, and end.")
  }
  let policy = loadPolicy(request.policyPath)
  guard let event = existingEvent(eventId, policy: policy) else {
    fail("calendar_denied", "That event is not on a calendar open for writes.")
  }
  if let calendarId = request.calendarId?.trimmingCharacters(in: .whitespacesAndNewlines),
     !calendarId.isEmpty,
     calendarId != event.calendar.calendarIdentifier {
    guard let destination = calendar(id: calendarId, policy: policy) else {
      fail("calendar_denied", "That calendar is not open for writes.")
    }
    event.calendar = destination
  }
  event.startDate = start
  event.endDate = end
  if let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
    event.title = title
  }
  do {
    try store.save(event, span: .thisEvent, commit: true)
  } catch {
    fail("eventkit", error.localizedDescription)
  }
  emit(EventResult(event: eventOut(event)))
}

func delete(_ request: HelperRequest) -> Never {
  guard let eventId = request.eventId else {
    fail("bad_request", "Deleting an event needs an id.")
  }
  let policy = loadPolicy(request.policyPath)
  guard let event = existingEvent(eventId, policy: policy) else {
    fail("calendar_denied", "That event is not on a calendar open for writes.")
  }
  do {
    try store.remove(event, span: .thisEvent, commit: true)
  } catch {
    fail("eventkit", error.localizedDescription)
  }
  emit(OkResult())
}

let request = readRequest()
authorize()
switch request.op {
case "catalog": catalog()
case "events": events(request)
case "create": create(request)
case "update": update(request)
case "delete": delete(request)
default: fail("bad_request", "Unknown calendar operation \(request.op).")
}
