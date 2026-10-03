// Pointer and keyboard events on the main display, posted through Core
// Graphics. One function, `perform(json)`, takes an event as src/device/input.ts
// validates it. macOS delivers the events only while this app has the
// Accessibility permission.
#include <node_api.h>

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>

namespace {

// DOM KeyboardEvent.code to the Mac's virtual key code: physical keys, so a
// key means the same on every keyboard layout.
const std::map<std::string, CGKeyCode> keyCodes = {
    {"KeyA", 0},           {"KeyS", 1},           {"KeyD", 2},
    {"KeyF", 3},           {"KeyH", 4},           {"KeyG", 5},
    {"KeyZ", 6},           {"KeyX", 7},           {"KeyC", 8},
    {"KeyV", 9},           {"IntlBackslash", 10}, {"KeyB", 11},
    {"KeyQ", 12},          {"KeyW", 13},          {"KeyE", 14},
    {"KeyR", 15},          {"KeyY", 16},          {"KeyT", 17},
    {"Digit1", 18},        {"Digit2", 19},        {"Digit3", 20},
    {"Digit4", 21},        {"Digit6", 22},        {"Digit5", 23},
    {"Equal", 24},         {"Digit9", 25},        {"Digit7", 26},
    {"Minus", 27},         {"Digit8", 28},        {"Digit0", 29},
    {"BracketRight", 30},  {"KeyO", 31},          {"KeyU", 32},
    {"BracketLeft", 33},   {"KeyI", 34},          {"KeyP", 35},
    {"Enter", 36},         {"KeyL", 37},          {"KeyJ", 38},
    {"Quote", 39},         {"KeyK", 40},          {"Semicolon", 41},
    {"Backslash", 42},     {"Comma", 43},         {"Slash", 44},
    {"KeyN", 45},          {"KeyM", 46},          {"Period", 47},
    {"Tab", 48},           {"Space", 49},         {"Backquote", 50},
    {"Backspace", 51},     {"Escape", 53},        {"MetaRight", 54},
    {"MetaLeft", 55},      {"ShiftLeft", 56},     {"CapsLock", 57},
    {"AltLeft", 58},       {"ControlLeft", 59},   {"ShiftRight", 60},
    {"AltRight", 61},      {"ControlRight", 62},  {"Fn", 63},
    {"F17", 64},           {"NumpadDecimal", 65}, {"NumpadMultiply", 67},
    {"NumpadAdd", 69},     {"NumLock", 71},       {"NumpadDivide", 75},
    {"NumpadEnter", 76},   {"NumpadSubtract", 78}, {"F18", 79},
    {"F19", 80},           {"NumpadEqual", 81},   {"Numpad0", 82},
    {"Numpad1", 83},       {"Numpad2", 84},       {"Numpad3", 85},
    {"Numpad4", 86},       {"Numpad5", 87},       {"Numpad6", 88},
    {"Numpad7", 89},       {"F20", 90},           {"Numpad8", 91},
    {"Numpad9", 92},       {"F5", 96},            {"F6", 97},
    {"F7", 98},            {"F3", 99},            {"F8", 100},
    {"F9", 101},           {"F11", 103},          {"F13", 105},
    {"F16", 106},          {"F14", 107},          {"F10", 109},
    {"F12", 111},          {"F15", 113},          {"Insert", 114},
    {"Home", 115},         {"PageUp", 116},       {"Delete", 117},
    {"F4", 118},           {"End", 119},          {"F2", 120},
    {"PageDown", 121},     {"F1", 122},           {"ArrowLeft", 123},
    {"ArrowRight", 124},   {"ArrowDown", 125},    {"ArrowUp", 126},
};

const CGKeyCode commandKeys[] = {54, 55};
const CGKeyCode shiftKeys[] = {56, 60};
const CGKeyCode optionKeys[] = {58, 61};
const CGKeyCode controlKeys[] = {59, 62};

// How many UTF-16 units one keyboard event carries as text.
const NSUInteger textChunk = 20;
// How far apart, in points, two presses may be and still be a double click.
const double clickDistance = 4;

// What is held down, to let go of it when a session ends.
std::set<CGKeyCode> heldKeys;
std::set<int> heldButtons;

// The last press, to count the clicks of a double click as macOS does.
struct {
  CFAbsoluteTime time = 0;
  CGPoint point = CGPointZero;
  int button = -1;
  int count = 0;
} lastPress;

bool isHeld(const CGKeyCode (&keys)[2]) {
  return heldKeys.count(keys[0]) || heldKeys.count(keys[1]);
}

// The modifiers an event carries: those it names, and those held as keys.
CGEventFlags modifiers(NSDictionary *event) {
  CGEventFlags flags = 0;
  if ([event[@"meta"] boolValue] || isHeld(commandKeys))
    flags |= kCGEventFlagMaskCommand;
  if ([event[@"shift"] boolValue] || isHeld(shiftKeys))
    flags |= kCGEventFlagMaskShift;
  if ([event[@"alt"] boolValue] || isHeld(optionKeys))
    flags |= kCGEventFlagMaskAlternate;
  if ([event[@"ctrl"] boolValue] || isHeld(controlKeys))
    flags |= kCGEventFlagMaskControl;
  return flags;
}

void post(CGEventRef event, CGEventFlags flags = 0) {
  if (!event) return;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

// Buttons as the DOM numbers them: 0 left, 1 middle, 2 right.
CGMouseButton mouseButton(int button) {
  return button == 2   ? kCGMouseButtonRight
         : button == 1 ? kCGMouseButtonCenter
                       : kCGMouseButtonLeft;
}

CGEventType pressType(int button, bool down) {
  if (button == 2) return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
  if (button == 1) return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
  return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
}

CGEventType dragType(int button) {
  return button == 2   ? kCGEventRightMouseDragged
         : button == 1 ? kCGEventOtherMouseDragged
                       : kCGEventLeftMouseDragged;
}

void postPress(int button, bool down, CGPoint point, int clickCount,
               CGEventFlags flags) {
  CGEventRef event = CGEventCreateMouseEvent(nullptr, pressType(button, down),
                                             point, mouseButton(button));
  if (event)
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickCount);
  post(event, flags);
}

CGPoint pointerLocation() {
  CGEventRef event = CGEventCreate(nullptr);
  if (!event) return CGPointZero;
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  return point;
}

// A position from 0 to 1 across the main display, in its points.
CGPoint displayPoint(NSDictionary *event) {
  CGRect bounds = CGDisplayBounds(CGMainDisplayID());
  double x = std::clamp([event[@"x"] doubleValue], 0.0, 1.0);
  double y = std::clamp([event[@"y"] doubleValue], 0.0, 1.0);
  return CGPointMake(bounds.origin.x + x * (bounds.size.width - 1),
                     bounds.origin.y + y * (bounds.size.height - 1));
}

void releaseAll() {
  for (CGKeyCode key : heldKeys)
    post(CGEventCreateKeyboardEvent(nullptr, key, false));
  heldKeys.clear();
  CGPoint point = pointerLocation();
  for (int button : heldButtons) postPress(button, false, point, 1, 0);
  heldButtons.clear();
}

// Returns what went wrong, or nil.
NSString *pressKey(NSDictionary *event) {
  auto found = keyCodes.find([event[@"code"] UTF8String] ?: "");
  if (found == keyCodes.end()) return @"Unsupported keyboard code";
  CGKeyCode key = found->second;
  bool down = [event[@"down"] boolValue];
  bool repeat = down && heldKeys.count(key);
  if (down)
    heldKeys.insert(key);
  else
    heldKeys.erase(key);
  CGEventRef keyEvent = CGEventCreateKeyboardEvent(nullptr, key, down);
  if (keyEvent)
    CGEventSetIntegerValueField(keyEvent, kCGKeyboardEventAutorepeat, repeat);
  post(keyEvent, modifiers(event));
  return nil;
}

// Text goes as the characters themselves, whatever the keyboard layout.
NSString *typeText(NSDictionary *event) {
  NSString *text = event[@"text"];
  if (![text isKindOfClass:[NSString class]]) return @"Invalid text";
  for (NSUInteger offset = 0; offset < text.length;) {
    NSUInteger length = std::min(textChunk, text.length - offset);
    // A character outside the basic plane is two units; keep them together.
    if (offset + length < text.length &&
        CFStringIsSurrogateHighCharacter(
            [text characterAtIndex:offset + length - 1]))
      length--;
    UniChar units[textChunk];
    [text getCharacters:units range:NSMakeRange(offset, length)];
    for (bool down : {true, false}) {
      CGEventRef keyEvent = CGEventCreateKeyboardEvent(nullptr, 0, down);
      if (keyEvent) CGEventKeyboardSetUnicodeString(keyEvent, length, units);
      post(keyEvent);
    }
    offset += length;
  }
  return nil;
}

void scroll(NSDictionary *event) {
  // The DOM's wheel deltas point the other way from Core Graphics'.
  int dy = (int)[event[@"dy"] doubleValue];
  int dx = (int)[event[@"dx"] doubleValue];
  post(CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 2, -dy,
                                     -dx),
       modifiers(event));
}

void movePointer(NSDictionary *event) {
  CGPoint point = displayPoint(event);
  // With a button held, a move is a drag of that button.
  if (heldButtons.empty()) {
    post(CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, point,
                                 kCGMouseButtonLeft),
         modifiers(event));
    return;
  }
  int button = *heldButtons.begin();
  post(CGEventCreateMouseEvent(nullptr, dragType(button), point,
                               mouseButton(button)),
       modifiers(event));
}

void pressButton(NSDictionary *event, bool down) {
  CGPoint point = displayPoint(event);
  int button = (int)[event[@"button"] integerValue];
  if (down) {
    heldButtons.insert(button);
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    bool again = button == lastPress.button &&
                 now - lastPress.time <= [NSEvent doubleClickInterval] &&
                 std::hypot(point.x - lastPress.point.x,
                            point.y - lastPress.point.y) < clickDistance;
    lastPress.count = again ? lastPress.count + 1 : 1;
    lastPress.time = now;
    lastPress.point = point;
    lastPress.button = button;
  } else {
    heldButtons.erase(button);
  }
  postPress(button, down, point, std::max(1, lastPress.count),
            modifiers(event));
}

void click(NSDictionary *event) {
  CGPoint point = displayPoint(event);
  int button = (int)[event[@"button"] integerValue];
  int count = [event[@"count"] intValue] == 2 ? 2 : 1;
  CGEventFlags flags = modifiers(event);
  for (int press = 1; press <= count; press++) {
    postPress(button, true, point, press, flags);
    postPress(button, false, point, press, flags);
  }
}

// Returns what went wrong, or nil.
NSString *performEvent(NSDictionary *event) {
  if (!AXIsProcessTrusted()) {
    // Nothing more can be posted: what was held cannot be let go either.
    heldKeys.clear();
    heldButtons.clear();
    return @"Accessibility permission is required";
  }
  NSString *action = event[@"action"];
  if (![action isKindOfClass:[NSString class]]) return @"Unknown input action";
  if ([action isEqualToString:@"release"]) {
    releaseAll();
  } else if ([action isEqualToString:@"key"]) {
    return pressKey(event);
  } else if ([action isEqualToString:@"type"]) {
    return typeText(event);
  } else if ([action isEqualToString:@"scroll"]) {
    scroll(event);
  } else if ([action isEqualToString:@"move"]) {
    movePointer(event);
  } else if ([action isEqualToString:@"down"]) {
    pressButton(event, true);
  } else if ([action isEqualToString:@"up"]) {
    pressButton(event, false);
  } else if ([action isEqualToString:@"click"]) {
    click(event);
  } else {
    return @"Unknown input action";
  }
  return nil;
}

napi_value perform(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argumentCount = 1;
    napi_value argument;
    napi_get_cb_info(env, info, &argumentCount, &argument, nullptr, nullptr);
    size_t size = 0;
    if (argumentCount != 1 ||
        napi_get_value_string_utf8(env, argument, nullptr, 0, &size) !=
            napi_ok) {
      napi_throw_type_error(env, nullptr, "Expected an input event as JSON");
      return nullptr;
    }
    std::string json(size + 1, '\0');
    napi_get_value_string_utf8(env, argument, json.data(), json.size(), &size);
    id event = [NSJSONSerialization
        JSONObjectWithData:[NSData dataWithBytes:json.data() length:size]
                   options:0
                     error:nil];
    if (![event isKindOfClass:[NSDictionary class]]) {
      napi_throw_type_error(env, nullptr, "Expected an input event as JSON");
      return nullptr;
    }
    if (NSString *error = performEvent(event)) {
      napi_throw_error(env, nullptr, error.UTF8String);
      return nullptr;
    }
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "perform", NAPI_AUTO_LENGTH, perform, nullptr,
                       &function);
  napi_set_named_property(env, exports, "perform", function);
  return exports;
}

}  // namespace

NAPI_MODULE(input, initialize)
