// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * Serialises the accessibility tree in the format `uiautomator dump` writes, so
 * the host parses both the same way. Same attributes in the same order, same
 * rule of skipping children that are not visible to the user, bounds clipped to
 * the display. Two additions: `hint` on API 26+, and `window` on each root when
 * every window is dumped.
 */
final class Hierarchy {
    private Hierarchy() {}

    /** Returns null when there is no window to dump (mid-transition, screen off). */
    static String dump(UiAutomation ui, boolean allWindows, int[] display) {
        int width = display != null ? display[0] : 0;
        int height = display != null ? display[1] : 0;
        StringBuilder sb = new StringBuilder(128 * 1024);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
        sb.append("<hierarchy rotation=\"").append(display != null ? display[2] : 0).append('"');
        if (display != null) sb.append(" width=\"").append(width).append("\" height=\"").append(height).append('"');
        sb.append('>');

        int roots = 0;
        if (allWindows) {
            List<AccessibilityWindowInfo> windows = ui.getWindows();
            // getWindows() lists the topmost window first; emit bottom-up so
            // later nodes are the ones drawn on top.
            for (int i = windows.size() - 1; i >= 0; i--) {
                AccessibilityWindowInfo w = windows.get(i);
                AccessibilityNodeInfo root = w.getRoot();
                if (root == null) continue;
                node(sb, root, 0, width, height, windowType(w.getType()));
                roots++;
            }
        } else {
            AccessibilityNodeInfo root = ui.getRootInActiveWindow();
            if (root != null) {
                node(sb, root, 0, width, height, null);
                roots++;
            }
        }
        if (roots == 0) return null;
        sb.append("</hierarchy>");
        return sb.toString();
    }

    private static void node(StringBuilder sb, AccessibilityNodeInfo n, int index, int width, int height,
                             String window) {
        sb.append("<node");
        attr(sb, "index", Integer.toString(index));
        attr(sb, "text", n.getText());
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName());
        attr(sb, "package", n.getPackageName());
        attr(sb, "content-desc", n.getContentDescription());
        attr(sb, "checkable", n.isCheckable());
        attr(sb, "checked", n.isChecked());
        attr(sb, "clickable", n.isClickable());
        attr(sb, "enabled", n.isEnabled());
        attr(sb, "focusable", n.isFocusable());
        attr(sb, "focused", n.isFocused());
        attr(sb, "scrollable", n.isScrollable());
        attr(sb, "long-clickable", n.isLongClickable());
        attr(sb, "password", n.isPassword());
        attr(sb, "selected", n.isSelected());
        if (Build.VERSION.SDK_INT >= 26) {
            CharSequence hint = n.getHintText();
            if (hint != null && hint.length() > 0) attr(sb, "hint", hint);
        }
        if (window != null) attr(sb, "window", window);
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        if (width > 0 && height > 0) r.intersect(0, 0, width, height);
        attr(sb, "bounds", "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]");
        sb.append('>');

        int count = n.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = n.getChild(i);
            if (child != null && child.isVisibleToUser()) node(sb, child, i, width, height, null);
        }
        sb.append("</node>");
    }

    private static String windowType(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input-method";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility-overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "split-screen-divider";
            default: return Integer.toString(type);
        }
    }

    private static void attr(StringBuilder sb, String name, boolean value) {
        sb.append(' ').append(name).append("=\"").append(value).append('"');
    }

    private static void attr(StringBuilder sb, String name, CharSequence value) {
        sb.append(' ').append(name).append("=\"");
        if (value != null) escape(sb, value);
        sb.append('"');
    }

    /** XML-escapes an attribute value; control characters other than tab and newlines become '.'. */
    private static void escape(StringBuilder sb, CharSequence s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                case '\n': sb.append("&#10;"); break;
                case '\r': sb.append("&#13;"); break;
                case '\t': sb.append("&#9;"); break;
                default:
                    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0xfffe || c == 0xffff) sb.append('.');
                    else sb.append(c);
            }
        }
    }
}
