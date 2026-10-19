// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Point;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.Display;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Owns the one UiAutomation connection the system allows at a time.
 *
 * Everything that creates and connects it is hidden API, reached by reflection
 * because the signatures move between releases: up to Android 13 the
 * constructor takes a Looper, later ones may take a Context instead.
 */
final class Automation {
    /** UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, API 24. Keeps TalkBack running. */
    private static final int FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 1;

    final UiAutomation ui;
    private final HandlerThread thread;

    private Automation(UiAutomation ui, HandlerThread thread) {
        this.ui = ui;
        this.thread = thread;
    }

    static Automation connect() throws Exception {
        HandlerThread thread = new HandlerThread("adbax-automation");
        thread.start();
        Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
        Object connection = Class.forName("android.app.UiAutomationConnection")
                .getDeclaredConstructor().newInstance();

        UiAutomation ui = construct(thread.getLooper(), iface, connection);
        try {
            Method m = UiAutomation.class.getDeclaredMethod("connect", int.class);
            m.setAccessible(true);
            m.invoke(ui, FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        } catch (InvocationTargetException e) {
            throw unwrap(e);
        }

        AccessibilityServiceInfo info = ui.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        ui.setServiceInfo(info);
        return new Automation(ui, thread);
    }

    /**
     * Drops the accessibility node cache, so the next read fetches the tree
     * from the app. The framework invalidates cached nodes from accessibility
     * events, but not every toolkit sends the right ones: a Compose text field
     * kept reporting text from three edits ago. A fresh `uiautomator dump`
     * never sees this because its cache starts empty.
     *
     * UiAutomation.clearCache() exists from Android 14. Before that the same
     * thing is AccessibilityInteractionClient.clearCache(connectionId), which
     * is what setServiceInfo() calls first; that call is the last resort.
     */
    void clearCache() {
        try {
            Method m = UiAutomation.class.getMethod("clearCache");
            m.invoke(ui);
            return;
        } catch (Exception ignored) {
            // Not on this release.
        }
        try {
            Field f = UiAutomation.class.getDeclaredField("mConnectionId");
            f.setAccessible(true);
            int id = f.getInt(ui);
            Class<?> client = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
            Object instance = client.getMethod("getInstance").invoke(null);
            client.getMethod("clearCache", int.class).invoke(instance, id);
            return;
        } catch (Exception ignored) {
            // Renamed or gone; setServiceInfo still clears it.
        }
        ui.setServiceInfo(ui.getServiceInfo());
    }

    /**
     * getWindows() needs FLAG_RETRIEVE_INTERACTIVE_WINDOWS, but with it set the
     * framework also marks views scrolled underneath other views as invisible,
     * so a dump would differ from what `uiautomator dump` prints for the same
     * screen. It is only on while a --windows dump runs.
     */
    void interactiveWindows(boolean on) {
        AccessibilityServiceInfo info = ui.getServiceInfo();
        int flag = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        info.flags = on ? info.flags | flag : info.flags & ~flag;
        ui.setServiceInfo(info);
    }

    private static UiAutomation construct(Looper looper, Class<?> iface, Object connection) throws Exception {
        try {
            Constructor<UiAutomation> c = UiAutomation.class.getDeclaredConstructor(Looper.class, iface);
            c.setAccessible(true);
            return c.newInstance(looper, connection);
        } catch (NoSuchMethodException ignored) {
            // Falls through to the Context constructor.
        } catch (InvocationTargetException e) {
            throw unwrap(e);
        }
        try {
            Constructor<UiAutomation> c = UiAutomation.class.getDeclaredConstructor(Context.class, iface);
            c.setAccessible(true);
            return c.newInstance(systemContext(), connection);
        } catch (InvocationTargetException e) {
            throw unwrap(e);
        }
    }

    /** A system Context for a process that has no application, the way scrcpy gets one. */
    private static Context systemContext() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> c = at.getDeclaredConstructor();
        c.setAccessible(true);
        Object thread = c.newInstance();
        Field current = at.getDeclaredField("sCurrentActivityThread");
        current.setAccessible(true);
        current.set(null, thread);
        Method m = at.getDeclaredMethod("getSystemContext");
        m.setAccessible(true);
        return (Context) m.invoke(thread);
    }

    /** {width, height, rotation} of the default display, or null if the hidden API is gone. */
    static int[] display() {
        try {
            Object global = Class.forName("android.hardware.display.DisplayManagerGlobal")
                    .getMethod("getInstance").invoke(null);
            Display d = (Display) global.getClass().getMethod("getRealDisplay", int.class).invoke(global, 0);
            Point p = new Point();
            d.getRealSize(p);
            return new int[] {p.x, p.y, d.getRotation()};
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * "package/class" of the activity on top of the focused task, or null.
     * The binder call has moved across releases: getStackInfo(getFocusedStackId())
     * on IActivityManager up to Android 8.1, getFocusedStackInfo from 9, on
     * IActivityTaskManager from 10, getFocusedRootTaskInfo from 12. Each returns
     * an object with a public topActivity field. Needs MANAGE_ACTIVITY_TASKS,
     * which the shell user has.
     */
    static String topActivity() {
        try {
            Object service = activityTaskService();
            Object info = null;
            for (String name : new String[] {"getFocusedRootTaskInfo", "getFocusedStackInfo"}) {
                try {
                    info = service.getClass().getMethod(name).invoke(service);
                    break;
                } catch (NoSuchMethodException ignored) {
                    // Older name on older releases.
                }
            }
            if (info == null) {
                Object id = service.getClass().getMethod("getFocusedStackId").invoke(service);
                info = service.getClass().getMethod("getStackInfo", int.class).invoke(service, id);
            }
            if (info == null) return null;
            Object top = info.getClass().getField("topActivity").get(info);
            return top instanceof android.content.ComponentName
                    ? ((android.content.ComponentName) top).flattenToShortString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static Object activityTaskService() throws Exception {
        try {
            return Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null);
        } catch (ClassNotFoundException | NoSuchMethodException e) {
            // API 26-28: still on IActivityManager.
            return Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
        }
    }

    void disconnect() {
        try {
            Method m = UiAutomation.class.getDeclaredMethod("disconnect");
            m.setAccessible(true);
            m.invoke(ui);
        } catch (Exception ignored) {
            // The process is about to exit; binder death unregisters it anyway.
        }
        thread.quitSafely();
    }

    private static Exception unwrap(InvocationTargetException e) {
        Throwable cause = e.getCause();
        if (cause instanceof Exception) return (Exception) cause;
        return e;
    }
}
