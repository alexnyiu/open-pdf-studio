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
for _ in 0..<10 where !activated {
    _ = application.unhide()
    activated = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        || application.isActive
    if !activated { usleep(100_000) }
}
guard activated else { fail("could not activate application process \(pid)") }
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
    // Tauri's client coordinates start below the standard macOS title bar.
    // CGWindow bounds include that title bar when WebKit does not publish an
    // AXWebArea, so retain the horizontal origin and add the native inset.
    ?? CGPoint(x: windowBounds.minX, y: windowBounds.minY + 28)
let point = CGPoint(
    x: interactionOrigin.x + number(3, "x"),
    y: interactionOrigin.y + number(4, "y")
)

var payload: [String: Any] = [
    "mode": mode,
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

if mode == "insert" {
    guard CommandLine.arguments.count == 7 else { fail("insert requires x y offset text") }
    let offset = Int(number(5, "offset"))
    guard offset >= 0 else { fail("offset must be non-negative") }
    let text = CommandLine.arguments[6]
    postKey(0, flags: .maskCommand) // Command+A selects the current editor.
    postKey(123) // Left collapses the selection to the start.
    for _ in 0..<offset { postKey(124) } // Right advances to the interior caret.
    postUnicode(text)
    payload["offset"] = offset
    payload["text"] = text
} else if mode == "click" {
    postMouseClick(point)
} else {
    fail("unsupported mode: \(mode)")
}

usleep(250_000)
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
