// Prints the modifiers the system thinks are held, for the Namespace
// macOS tests: "cmd shift alt ctrl", some of them, or "none".
import CoreGraphics

let flags = CGEventSource.flagsState(.hidSystemState)
let names: [(String, CGEventFlags)] = [
  ("cmd", .maskCommand), ("shift", .maskShift), ("alt", .maskAlternate), ("ctrl", .maskControl),
]
let held = names.filter { flags.contains($0.1) }.map { $0.0 }
print(held.isEmpty ? "none" : held.joined(separator: " "))
