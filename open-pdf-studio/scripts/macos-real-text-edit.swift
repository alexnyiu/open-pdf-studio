import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

func number(_ index: Int, _ name: String) -> Double {
    guard CommandLine.arguments.indices.contains(index),
          let value = Double(CommandLine.arguments[index]) else {
        fail("missing or invalid \(name)")
    }
    return value
}

func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

func axChildren(_ element: AXUIElement, _ attribute: CFString = kAXChildrenAttribute as CFString) -> [AXUIElement] {
    axAttribute(element, attribute) as? [AXUIElement] ?? []
}

func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let rawValue = axAttribute(element, attribute),
          CFGetTypeID(rawValue) == AXValueGetTypeID() else { return nil }
    let value = rawValue as! AXValue
    guard AXValueGetType(value) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func findWebArea(_ root: AXUIElement) -> AXUIElement? {
    var queue: [AXUIElement] = [root]
    var inspected = 0
    while !queue.isEmpty && inspected < 512 {
        let element = queue.removeFirst()
        inspected += 1
        if axString(element, kAXRoleAttribute as CFString) == "AXWebArea" { return element }
        queue.append(contentsOf: axChildren(element))
    }
    return nil
}

func postMouseClick(_ point: CGPoint) {
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { fail("could not create mouse event") }
        event.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        fail("could not create keyboard event")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(25_000)
    up.post(tap: .cghidEventTap)
    usleep(25_000)
}

func postUnicode(_ string: String) {
    let utf16 = Array(string.utf16)
    guard !utf16.isEmpty,
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        fail("could not create Unicode keyboard event")
    }
    utf16.withUnsafeBufferPointer { buffer in
        guard let baseAddress = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
    }
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
}

guard CommandLine.arguments.count >= 5 else {
    fail("usage: macos-real-text-edit.swift <pid> click <x> <y> | <pid> insert <x> <y> <offset> <text>")
}
let pid = pid_t(number(1, "pid"))
let mode = CommandLine.arguments[2]
guard let application = NSRunningApplication(processIdentifier: pid) else {
    fail("application process \(pid) is not running")
}
var activated = application.isActive
for _ in 0..<20 where !activated {
    _ = application.unhide()
    activated = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        || application.isActive
    if !activated { usleep(100_000) }
}
guard activated else { fail("could not activate application process \(pid)") }
var frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
for _ in 0..<20 where frontmostPid != pid {
    _ = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    usleep(100_000)
    frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
}
guard frontmostPid == pid else {
    fail("application process \(pid) did not become frontmost; frontmost=\(frontmostPid ?? -1)")
}
guard AXIsProcessTrusted() else { fail("macOS Accessibility permission is unavailable") }
guard CGPreflightPostEventAccess() else { fail("macOS Input Monitoring permission is unavailable") }
usleep(200_000)

guard let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]],
      let window = rawWindows.first(where: { entry in
          let owner = entry[kCGWindowOwnerPID as String] as? Int
          let layer = entry[kCGWindowLayer as String] as? Int
          guard owner == Int(pid), layer == 0,
                let rawBounds = entry[kCGWindowBounds as String],
                let rect = CGRect(dictionaryRepresentation: rawBounds as! CFDictionary) else {
              return false
          }
          return rect.width > 200 && rect.height > 200
      }),
      let rawBounds = window[kCGWindowBounds as String],
      let windowBounds = CGRect(dictionaryRepresentation: rawBounds as! CFDictionary) else {
    fail("could not locate the application window")
}

let accessibilityApplication = AXUIElementCreateApplication(pid)
let accessibilityWindow = axChildren(accessibilityApplication, kAXWindowsAttribute as CFString).first
let webArea = accessibilityWindow.flatMap(findWebArea)
let interactionOrigin = webArea.flatMap { axPoint($0, kAXPositionAttribute as CFString) }
    // The packaged main window is borderless (`decorations: false`), so its
    // WebView client origin is the CGWindow origin when WebKit does not expose
    // an AXWebArea. Adding a native title-bar inset clicks below short editors.
    ?? CGPoint(x: windowBounds.minX, y: windowBounds.minY)
let point = CGPoint(
    x: interactionOrigin.x + number(3, "x"),
    y: interactionOrigin.y + number(4, "y")
)

var payload: [String: Any] = [
    "mode": mode,
    "targetPid": pid,
    "frontmostPid": frontmostPid ?? -1,
    "point": ["x": point.x, "y": point.y],
    "authorization": [
        "accessibilityTrusted": AXIsProcessTrusted(),
        "postEventTrusted": CGPreflightPostEventAccess(),
    ],
    "coordinateSpace": [
        "origin": webArea == nil ? "window" : "web-area",
        "x": interactionOrigin.x,
        "y": interactionOrigin.y,
    ],
    "window": [
        "x": windowBounds.minX,
        "y": windowBounds.minY,
        "width": windowBounds.width,
        "height": windowBounds.height,
    ],
]
var eventSequence: [String] = []

func focusedRole() -> String? {
    guard let rawFocused = axAttribute(
        accessibilityApplication,
        kAXFocusedUIElementAttribute as CFString
    ), CFGetTypeID(rawFocused) == AXUIElementGetTypeID() else { return nil }
    let focused = rawFocused as! AXUIElement
    return axString(focused, kAXRoleAttribute as CFString)
}

if mode == "insert" {
    guard CommandLine.arguments.count == 7 else { fail("insert requires x y offset text") }
    let offset = Int(number(5, "offset"))
    guard offset >= 0 else { fail("offset must be non-negative") }
    let text = CommandLine.arguments[6]
    postMouseClick(point)
    eventSequence.append("physical-click-editor-point")
    usleep(100_000)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("target application lost frontmost status after editor click")
    }
    payload["focusedAccessibilityRole"] = focusedRole() ?? NSNull()
    postKey(0, flags: .maskCommand) // Command+A selects the current editor.
    eventSequence.append("command-a")
    postKey(123) // Left collapses the selection to the start.
    eventSequence.append("left-to-selection-start")
    for _ in 0..<offset { postKey(124) } // Right advances to the interior caret.
    eventSequence.append("right-by-\(offset)")
    postUnicode(text)
    eventSequence.append("unicode-insert")
    payload["offset"] = offset
    payload["text"] = text
} else if mode == "click" {
    postMouseClick(point)
    eventSequence.append("physical-click")
} else {
    fail("unsupported mode: \(mode)")
}

usleep(250_000)
payload["frontmostPidAfterEvents"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
payload["focusedAccessibilityRoleAfterEvents"] = focusedRole() ?? NSNull()
payload["eventSequence"] = eventSequence
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
