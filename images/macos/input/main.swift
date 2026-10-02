// proofbox's input helper for macOS: pointer, keys, and scroll through
// CGEvent, in points. images/macos/pixel.sh calls it; build it with
// images/macos/build-input.sh.
//
//   size                      print the main display size: W H
//   where                     print the pointer: X Y
//   move X Y MS               glide to X Y over MS ms (0 jumps)
//   click BUTTON              press and release at the pointer (1 2 3)
//   type LETTER_MS TEXT       type TEXT, LETTER_MS between characters
//   key KEYS                  xdotool keys: "ctrl+a Return", "cmd+equal"
//   scroll BUTTON STEPS       4 up, 5 down, 6 left, 7 right
//   drag X1 Y1 X2 Y2 MS       left-drag from X1 Y1 to X2 Y2

import Carbon.HIToolbox
import CoreGraphics
import Foundation

func die(_ reason: String) -> Never {
  FileHandle.standardError.write("input: \(reason)\n".data(using: .utf8)!)
  exit(2)
}

func number(_ text: String) -> Double {
  guard let value = Double(text) else { die("not a number: \(text)") }
  return value
}

func pause(_ ms: Double) {
  if ms > 0 { usleep(useconds_t(ms * 1000)) }
}

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  guard let event else { die("could not make an event") }
  event.post(tap: .cghidEventTap)
}

func pointer() -> CGPoint {
  CGEvent(source: nil)?.location ?? .zero
}

// Ease in and out like images/linux/pixel.sh, in steps of about 20 ms.
func glide(to target: CGPoint, ms: Double, dragging: Bool = false) {
  let type: CGEventType = dragging ? .leftMouseDragged : .mouseMoved
  if ms <= 0 {
    post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: target, mouseButton: .left))
    return
  }
  let start = pointer()
  let steps = Int((ms + 19) / 20)
  for i in 1...steps {
    let p = Double(i) / Double(steps)
    let e = p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2
    let at = CGPoint(x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e)
    post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left))
    pause(ms / Double(steps))
  }
}

func click(_ button: String) {
  let at = pointer()
  let (down, up, which): (CGEventType, CGEventType, CGMouseButton)
  switch button {
  case "1": (down, up, which) = (.leftMouseDown, .leftMouseUp, .left)
  case "2": (down, up, which) = (.otherMouseDown, .otherMouseUp, .center)
  case "3": (down, up, which) = (.rightMouseDown, .rightMouseUp, .right)
  default: die("unknown button \(button)")
  }
  post(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: at, mouseButton: which))
  pause(30)
  post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: at, mouseButton: which))
}

func type(_ text: String, letterMs: Double) {
  for character in text {
    let units = Array(String(character).utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      post(event)
    }
    pause(letterMs)
  }
}

let modifiers: [String: CGEventFlags] = [
  "ctrl": .maskControl, "control": .maskControl,
  "shift": .maskShift,
  "alt": .maskAlternate, "option": .maskAlternate,
  "super": .maskCommand, "cmd": .maskCommand, "meta": .maskCommand,
  "Shift_L": .maskShift, "Shift_R": .maskShift,
  "Control_L": .maskControl, "Control_R": .maskControl,
  "Alt_L": .maskAlternate, "Alt_R": .maskAlternate,
  "Super_L": .maskCommand, "Super_R": .maskCommand, "Meta_L": .maskCommand, "Meta_R": .maskCommand,
]

// The key each modifier is, pressed around the combo so the system does
// not think it stays held after.
let modifierKeys: [String: Int] = [
  "ctrl": kVK_Control, "control": kVK_Control,
  "shift": kVK_Shift,
  "alt": kVK_Option, "option": kVK_Option,
  "super": kVK_Command, "cmd": kVK_Command, "meta": kVK_Command,
  "Shift_L": kVK_Shift, "Shift_R": kVK_RightShift,
  "Control_L": kVK_Control, "Control_R": kVK_RightControl,
  "Alt_L": kVK_Option, "Alt_R": kVK_RightOption,
  "Super_L": kVK_Command, "Super_R": kVK_RightCommand, "Meta_L": kVK_Command, "Meta_R": kVK_RightCommand,
]

let named: [String: Int] = [
  "Return": kVK_Return, "Tab": kVK_Tab, "space": kVK_Space,
  "BackSpace": kVK_Delete, "Escape": kVK_Escape, "Delete": kVK_ForwardDelete,
  "Left": kVK_LeftArrow, "Right": kVK_RightArrow, "Up": kVK_UpArrow, "Down": kVK_DownArrow,
  "Home": kVK_Home, "End": kVK_End, "Page_Up": kVK_PageUp, "Page_Down": kVK_PageDown,
  "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
  "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
  "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
  "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
  "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
  "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
  "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
  "z": kVK_ANSI_Z,
  "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
  "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
  "equal": kVK_ANSI_Equal, "minus": kVK_ANSI_Minus, "comma": kVK_ANSI_Comma,
  "period": kVK_ANSI_Period, "slash": kVK_ANSI_Slash, "backslash": kVK_ANSI_Backslash,
  "semicolon": kVK_ANSI_Semicolon, "apostrophe": kVK_ANSI_Quote, "grave": kVK_ANSI_Grave,
  "bracketleft": kVK_ANSI_LeftBracket, "bracketright": kVK_ANSI_RightBracket,
]

// The symbols Shift gives on a US keyboard, each with the key it is on.
let shifted: [String: Int] = [
  "plus": kVK_ANSI_Equal, "exclam": kVK_ANSI_1, "at": kVK_ANSI_2, "numbersign": kVK_ANSI_3,
  "dollar": kVK_ANSI_4, "percent": kVK_ANSI_5, "asciicircum": kVK_ANSI_6, "ampersand": kVK_ANSI_7,
  "asterisk": kVK_ANSI_8, "parenleft": kVK_ANSI_9, "parenright": kVK_ANSI_0,
  "underscore": kVK_ANSI_Minus, "colon": kVK_ANSI_Semicolon, "quotedbl": kVK_ANSI_Quote,
  "less": kVK_ANSI_Comma, "greater": kVK_ANSI_Period, "question": kVK_ANSI_Slash,
  "braceleft": kVK_ANSI_LeftBracket, "braceright": kVK_ANSI_RightBracket,
  "bar": kVK_ANSI_Backslash, "asciitilde": kVK_ANSI_Grave,
]

func press(_ code: Int, down: Bool, flags: CGEventFlags) {
  let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down)
  event?.flags = flags
  post(event)
}

// Each space-separated combo is "mod+mod+key", as xdotool takes it. The
// modifier keys go down first and up last, so no modifier stays held for
// the next command.
func key(_ keys: String) {
  for combo in keys.split(separator: " ") {
    let parts = combo.split(separator: "+").map(String.init)
    guard let last = parts.last else { continue }
    var held: [(code: Int, flag: CGEventFlags)] = []
    func hold(_ code: Int, _ flag: CGEventFlags) {
      // Names that share a key, like cmd and meta, press it once.
      if !held.contains(where: { $0.flag == flag }) {
        held.append((code, flag))
      }
    }
    for name in parts.dropLast() {
      guard let flag = modifiers[name], let code = modifierKeys[name] else { die("unknown modifier \(name)") }
      hold(code, flag)
    }
    // The last name is a modifier on its own, a symbol that needs Shift,
    // or a named key. A modifier on its own is only held and let go.
    var code: Int?
    if let flag = modifiers[last], let modifier = modifierKeys[last] {
      hold(modifier, flag)
    } else if let base = shifted[last] {
      hold(kVK_Shift, .maskShift)
      code = base
    } else if let plain = named[last] {
      code = plain
    } else {
      die("unknown key \(last)")
    }
    var flags: CGEventFlags = []
    for modifier in held {
      flags.insert(modifier.flag)
      press(modifier.code, down: true, flags: flags)
    }
    if let code {
      press(code, down: true, flags: flags)
      press(code, down: false, flags: flags)
    }
    for modifier in held.reversed() {
      flags.remove(modifier.flag)
      press(modifier.code, down: false, flags: flags)
    }
    pause(30)
  }
}

func scroll(_ button: String, steps: Int) {
  let (vertical, horizontal): (Int32, Int32)
  switch button {
  case "4": (vertical, horizontal) = (1, 0)
  case "5": (vertical, horizontal) = (-1, 0)
  case "6": (vertical, horizontal) = (0, 1)
  case "7": (vertical, horizontal) = (0, -1)
  default: die("unknown scroll button \(button)")
  }
  for _ in 0..<max(steps, 0) {
    post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0))
    pause(50)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
func arg(_ i: Int) -> String {
  guard i < args.count else { die("missing argument \(i) for \(args.first ?? "")") }
  return args[i]
}

switch args.first ?? "" {
case "size":
  let bounds = CGDisplayBounds(CGMainDisplayID())
  print("\(Int(bounds.width)) \(Int(bounds.height))")
case "where":
  let at = pointer()
  print("\(Int(at.x.rounded())) \(Int(at.y.rounded()))")
case "move":
  glide(to: CGPoint(x: number(arg(1)), y: number(arg(2))), ms: number(arg(3)))
case "click":
  click(arg(1))
case "type":
  type(arg(2), letterMs: number(arg(1)))
case "key":
  key(arg(1))
case "scroll":
  scroll(arg(1), steps: Int(number(arg(2))))
case "drag":
  let ms = number(arg(5))
  glide(to: CGPoint(x: number(arg(1)), y: number(arg(2))), ms: ms)
  let from = pointer()
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
  pause(50)
  glide(to: CGPoint(x: number(arg(3)), y: number(arg(4))), ms: ms, dragging: true)
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pointer(), mouseButton: .left))
default:
  die("unknown command \(args.first ?? "")")
}
