// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Touch and key injection through the UiAutomation connection. It does what
 * `adb shell input` does, minus starting a process per gesture, which on
 * Android 10 and older is a whole app_process VM.
 */
final class Input {
    private Input() {}

    static void tap(UiAutomation ui, int x, int y) {
        long now = SystemClock.uptimeMillis();
        inject(ui, motion(MotionEvent.ACTION_DOWN, now, now, x, y));
        inject(ui, motion(MotionEvent.ACTION_UP, now, SystemClock.uptimeMillis(), x, y));
    }

    /** A straight drag; with identical endpoints and a long duration it is a long press. */
    static void swipe(UiAutomation ui, int x1, int y1, int x2, int y2, long durationMs) {
        long down = SystemClock.uptimeMillis();
        inject(ui, motion(MotionEvent.ACTION_DOWN, down, down, x1, y1));
        long end = down + Math.max(durationMs, 1);
        long now = SystemClock.uptimeMillis();
        while (now < end) {
            float f = (float) (now - down) / (end - down);
            inject(ui, motion(MotionEvent.ACTION_MOVE, down, now, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f));
            SystemClock.sleep(8);
            now = SystemClock.uptimeMillis();
        }
        inject(ui, motion(MotionEvent.ACTION_UP, down, now, x2, y2));
    }

    static void key(UiAutomation ui, int code, boolean longPress) {
        long now = SystemClock.uptimeMillis();
        inject(ui, keyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        if (longPress) {
            SystemClock.sleep(500);
            inject(ui, keyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_DOWN, code, 1));
        }
        inject(ui, keyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0));
    }

    /**
     * Types into the focused field as key events, the way `input text` does.
     * Text the virtual keyboard map cannot produce (umlauts, CJK, emoji) is
     * appended with ACTION_SET_TEXT instead. Returns how it went in, "keys" or
     * "settext", or null when it could not be typed at all.
     */
    static String type(UiAutomation ui, String text) {
        KeyCharacterMap map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        KeyEvent[] events = map.getEvents(text.toCharArray());
        if (events != null) {
            for (KeyEvent e : events) inject(ui, KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0));
            return "keys";
        }
        return setText(ui, text, true) != null ? "settext" : null;
    }

    /** The node holding input focus, or null. */
    /**
     * The field with input focus. findFocus misses one inside a dialog or bottom sheet,
     * which is its own window, so the active window is searched as well: its focused
     * editable node, else its only editable one.
     */
    static AccessibilityNodeInfo focused(UiAutomation ui) {
        AccessibilityNodeInfo f = ui.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f != null && f.isEditable()) return f;
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        if (root == null) return f;
        java.util.List<AccessibilityNodeInfo> editable = new java.util.ArrayList<AccessibilityNodeInfo>();
        collectEditable(root, editable, 0);
        for (AccessibilityNodeInfo n : editable) if (n.isFocused()) return n;
        return editable.size() == 1 ? editable.get(0) : f;
    }

    private static void collectEditable(AccessibilityNodeInfo node, java.util.List<AccessibilityNodeInfo> out, int depth) {
        if (node == null || depth > 60) return;
        if (node.isEditable()) out.add(node);
        for (int i = 0; i < node.getChildCount(); i++) collectEditable(node.getChild(i), out, depth + 1);
    }

    /**
     * Sets the focused field's text through ACTION_SET_TEXT. Unlike key events
     * this takes any Unicode, but it bypasses the IME, so it is the fallback for
     * text `input text` cannot type rather than the default.
     *
     * Returns the field's text afterwards, or null when no editable field has
     * input focus.
     */
    static CharSequence setText(UiAutomation ui, String text, boolean append) {
        AccessibilityNodeInfo field = focused(ui);
        if (field == null || !field.isEditable()) return null;
        String value = text;
        if (append) {
            CharSequence current = field.getText();
            boolean hint = android.os.Build.VERSION.SDK_INT >= 26 && field.isShowingHintText();
            if (current != null && !hint) value = current + text;
        }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return null;
        field.refresh();
        CharSequence after = field.getText();
        return after != null ? after : "";
    }

    private static MotionEvent motion(int action, long downTime, long eventTime, float x, float y) {
        MotionEvent e = MotionEvent.obtain(downTime, eventTime, action, x, y,
                action == MotionEvent.ACTION_UP ? 0f : 1f, 1f, 0, 1f, 1f, 0, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        return e;
    }

    private static KeyEvent keyEvent(long downTime, long eventTime, int action, int code, int repeat) {
        return new KeyEvent(downTime, eventTime, action, code, repeat, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD);
    }

    private static void inject(UiAutomation ui, android.view.InputEvent e) {
        if (!ui.injectInputEvent(e, true)) throw new IllegalStateException("input injection refused");
    }
}
