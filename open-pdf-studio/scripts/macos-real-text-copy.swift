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

func postMouse(_ type: CGEventType, _ point: CGPoint) {
    guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else { fail("could not create mouse event") }
    event.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, command: Bool) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        fail("could not create keyboard event")
    }
    if command {
        down.flags = .maskCommand
        up.flags = .maskCommand
    }
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
}

guard CommandLine.arguments.count >= 3 else {
    fail("usage: macos-real-text-copy.swift <pid> drag <x1> <y1> <x2> <y2> | <pid> all <x> <y> | <pid> all-center")
}
let pid = pid_t(number(1, "pid"))
let mode = CommandLine.arguments[2]
guard let application = NSRunningApplication(processIdentifier: pid) else {
    fail("application process \(pid) is not running")
}
guard application.activate(options: []) else {
    fail("could not activate application process \(pid)")
}
usleep(250_000)

guard let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]],
      let window = rawWindows.first(where: { entry in
          let owner = entry[kCGWindowOwnerPID as String] as? Int
          let layer = entry[kCGWindowLayer as String] as? Int
          guard owner == Int(pid), layer == 0,
                let bounds = entry[kCGWindowBounds as String],
                let rect = CGRect(dictionaryRepresentation: bounds as! CFDictionary) else { return false }
          return rect.width > 200 && rect.height > 200
      }),
      let boundsDictionary = window[kCGWindowBounds as String],
      let bounds = CGRect(dictionaryRepresentation: boundsDictionary as! CFDictionary) else {
    fail("could not locate the application window")
}

let pasteboard = NSPasteboard.general
pasteboard.clearContents()

if mode == "drag" {
    guard CommandLine.arguments.count == 7 else { fail("drag requires x1 y1 x2 y2") }
    let start = CGPoint(x: bounds.minX + number(3, "x1"), y: bounds.minY + number(4, "y1"))
    let end = CGPoint(x: bounds.minX + number(5, "x2"), y: bounds.minY + number(6, "y2"))
    postMouse(.mouseMoved, start)
    usleep(60_000)
    postMouse(.leftMouseDown, start)
    for step in 1...20 {
        let fraction = CGFloat(step) / 20
        let point = CGPoint(
            x: start.x + (end.x - start.x) * fraction,
            y: start.y + (end.y - start.y) * fraction
        )
        postMouse(.leftMouseDragged, point)
        usleep(12_000)
    }
    postMouse(.leftMouseUp, end)
} else if mode == "all" {
    guard CommandLine.arguments.count == 5 else { fail("all requires x y") }
    let point = CGPoint(x: bounds.minX + number(3, "x"), y: bounds.minY + number(4, "y"))
    postMouse(.mouseMoved, point)
    postMouse(.leftMouseDown, point)
    postMouse(.leftMouseUp, point)
    usleep(100_000)
    postKey(0, command: true) // A
} else if mode == "all-center" {
    guard CommandLine.arguments.count == 3 else { fail("all-center takes no coordinates") }
    let point = CGPoint(x: bounds.midX, y: bounds.midY)
    postMouse(.mouseMoved, point)
    postMouse(.leftMouseDown, point)
    postMouse(.leftMouseUp, point)
    usleep(100_000)
    postKey(0, command: true) // A
} else {
    fail("unsupported mode: \(mode)")
}

usleep(180_000)
postKey(8, command: true) // C
usleep(300_000)

let text = pasteboard.string(forType: .string) ?? ""
let payload: [String: Any] = [
    "status": text.isEmpty ? "empty" : "pass",
    "text": text,
    "window": [
        "x": bounds.minX,
        "y": bounds.minY,
        "width": bounds.width,
        "height": bounds.height,
    ],
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
