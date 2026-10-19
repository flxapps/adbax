// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.graphics.Bitmap;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeoutException;

/**
 * One request per connection on an abstract unix socket, which the host reaches
 * through `adb forward tcp:N localabstract:<name>`.
 *
 * Request:  one line of JSON, {"cmd": "dump", ...}.
 * Response: one line of JSON with "ok", "token" and "serial", then the payload
 *           (XML or image bytes) until the socket closes. The host checks both
 *           echoes: token for the build, serial for the device behind a port.
 *
 * Requests run one at a time on this thread; UiAutomation is not meant to be
 * driven concurrently and nothing here takes long enough to need it.
 */
final class Server {
    /** android.os.Process.SHELL_UID, which is only public from API 29. */
    private static final int SHELL_UID = 2000;

    private final String socketName;
    private final String token;
    private final String serial;
    private final long idleMs;
    private final long startedAt = SystemClock.uptimeMillis();
    private volatile long lastRequest = SystemClock.uptimeMillis();
    private Automation automation;

    Server(String socketName, String token, String serial, long idleMs) {
        this.socketName = socketName;
        this.token = token;
        this.serial = serial;
        this.idleMs = idleMs;
    }

    void run() throws Exception {
        // Bind first: a second server for the same device fails here, before
        // it can take the UiAutomation connection from the first.
        LocalServerSocket listener = new LocalServerSocket(socketName);
        automation = Automation.connect();
        System.err.println("adbax-server: listening on @" + socketName + ", sdk " + Build.VERSION.SDK_INT
                + ", pid " + Process.myPid());
        startIdleWatch();
        while (true) {
            LocalSocket client = listener.accept();
            if (!fromAdb(client)) {
                try { client.close(); } catch (IOException ignored) { }
                continue;
            }
            lastRequest = SystemClock.uptimeMillis();
            // A client that connects and never sends its line must not block the rest.
            client.setSoTimeout(10_000);
            boolean quit = false;
            try {
                quit = handle(client);
            } catch (Exception e) {
                System.err.println("adbax-server: request failed: " + e);
            } finally {
                try { client.close(); } catch (IOException ignored) { }
            }
            lastRequest = SystemClock.uptimeMillis();
            if (quit) {
                automation.disconnect();
                return;
            }
        }
    }

    /**
     * An abstract socket has no file permissions, so anything on the device that
     * finds the name could connect, and this process injects input as the shell
     * user. A forwarded connection comes from adbd, which runs as shell, or as
     * root after `adb root`; every other uid is an app and is turned away.
     */
    private static boolean fromAdb(LocalSocket client) {
        int uid;
        try {
            uid = client.getPeerCredentials().getUid();
        } catch (IOException e) {
            return false;
        }
        if (uid == 0 || uid == SHELL_UID) return true;
        System.err.println("adbax-server: refused a connection from uid " + uid);
        return false;
    }

    /** Exits after idleMs without a request, so the connection is not held forever. */
    private void startIdleWatch() {
        if (idleMs <= 0) return;
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                while (true) {
                    SystemClock.sleep(5_000);
                    if (SystemClock.uptimeMillis() - lastRequest > idleMs) {
                        System.err.println("adbax-server: idle for " + idleMs / 1000 + "s, exiting");
                        automation.disconnect();
                        System.exit(0);
                    }
                }
            }
        }, "adbax-idle");
        t.setDaemon(true);
        t.start();
    }

    private boolean handle(LocalSocket client) throws IOException {
        JSONObject req;
        try {
            req = new JSONObject(readLine(client.getInputStream()));
        } catch (JSONException e) {
            reply(client.getOutputStream(), error("bad request: " + e.getMessage()), null);
            return false;
        }
        OutputStream out = client.getOutputStream();
        JSONObject head = new JSONObject();
        byte[] body = null;
        String cmd = req.optString("cmd");
        try {
            head.put("ok", true);
            switch (cmd) {
                case "activity":
                    head.put("activity", Automation.topActivity());
                    break;
                case "ping": {
                    head.put("sdk", Build.VERSION.SDK_INT);
                    head.put("pid", Process.myPid());
                    head.put("uptimeMs", SystemClock.uptimeMillis() - startedAt);
                    // The size as currently rotated; `wm size` only knows the physical one.
                    int[] display = Automation.display();
                    if (display != null) {
                        head.put("width", display[0]);
                        head.put("height", display[1]);
                        head.put("rotation", display[2]);
                    }
                    break;
                }
                case "dump":
                    body = dump(req, head);
                    break;
                case "screenshot":
                    body = screenshot(req, head);
                    break;
                case "tap":
                    Input.tap(automation.ui, req.getInt("x"), req.getInt("y"));
                    break;
                case "swipe":
                    Input.swipe(automation.ui, req.getInt("x1"), req.getInt("y1"), req.getInt("x2"),
                            req.getInt("y2"), req.optLong("ms", 300));
                    break;
                case "key": {
                    // A number, or a name KeyEvent knows ("KEYCODE_ENTER", "ENTER").
                    String name = req.optString("name", "");
                    int code = name.isEmpty() ? req.getInt("code") : android.view.KeyEvent.keyCodeFromString(
                            name.startsWith("KEYCODE_") ? name : "KEYCODE_" + name);
                    if (code == android.view.KeyEvent.KEYCODE_UNKNOWN) {
                        head = error("unknown key: " + name);
                        break;
                    }
                    Input.key(automation.ui, code, req.optBoolean("long"));
                    break;
                }
                case "text": {
                    automation.clearCache();
                    String via = Input.type(automation.ui, req.getString("text"));
                    if (via == null) head = error("no editable field has input focus");
                    else head.put("via", via);
                    break;
                }
                case "focus": {
                    automation.clearCache();
                    android.view.accessibility.AccessibilityNodeInfo f = Input.focused(automation.ui);
                    head.put("focused", f != null);
                    if (f != null) {
                        head.put("editable", f.isEditable());
                        head.put("password", f.isPassword());
                        head.put("class", String.valueOf(f.getClassName()));
                        boolean hint = Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
                        head.put("text", hint || f.getText() == null ? "" : f.getText().toString());
                    }
                    break;
                }
                case "settext": {
                    automation.clearCache();
                    CharSequence now = Input.setText(automation.ui, req.getString("text"), req.optBoolean("append"));
                    if (now == null) head = error("no editable field has input focus");
                    else head.put("text", now.toString());
                    break;
                }
                case "quit":
                    reply(out, head, null);
                    return true;
                default:
                    head = error("unknown command: " + cmd);
            }
        } catch (Exception e) {
            head = error(cmd + ": " + e);
        }
        reply(out, head, body);
        return false;
    }

    /**
     * Waits `settle` ms for an action to start showing, then for `idle` ms
     * without accessibility events (at most `timeout`), then dumps. A screen that
     * never goes quiet is dumped anyway and flagged busy, where `uiautomator
     * dump` gives up with "could not get idle state".
     */
    private byte[] dump(JSONObject req, JSONObject head) throws Exception {
        long t0 = SystemClock.uptimeMillis();
        long settle = req.optLong("settle", 0);
        if (settle > 0) SystemClock.sleep(settle);
        long idle = req.optLong("idle", 300);
        long deadline = SystemClock.uptimeMillis() + req.optLong("timeout", 2000);
        boolean busy = !waitForIdle(idle, deadline);
        String activity = Automation.topActivity();
        // After an action, a top activity from another package than the active
        // window means the switch has not reached the accessibility tree yet.
        // Not checked on a plain read: with the notification shade or a system
        // dialog open the two disagree for as long as it stays open.
        boolean switching = false;
        if (settle > 0 && !req.optBoolean("windows")) {
            while (activity != null && !activity.startsWith(activeWindowPackage() + "/")
                    && SystemClock.uptimeMillis() < deadline) {
                switching = true;
                SystemClock.sleep(100);
                busy = !waitForIdle(idle, deadline);
                activity = Automation.topActivity();
            }
            switching = activity != null && !activity.startsWith(activeWindowPackage() + "/");
        }
        long t1 = SystemClock.uptimeMillis();
        int[] display = Automation.display();
        boolean windows = req.optBoolean("windows");
        String xml = null;
        if (windows) automation.interactiveWindows(true);
        automation.clearCache();
        try {
            for (int attempt = 0; attempt < 10 && xml == null; attempt++) {
                if (attempt > 0) SystemClock.sleep(100);
                xml = Hierarchy.dump(automation.ui, windows, display);
            }
        } finally {
            if (windows) automation.interactiveWindows(false);
        }
        if (xml == null) throw new IllegalStateException("no window to dump");
        head.put("busy", busy || switching);
        head.put("activity", activity);
        head.put("waitMs", t1 - t0);
        head.put("dumpMs", SystemClock.uptimeMillis() - t1);
        if (display != null) {
            head.put("width", display[0]);
            head.put("height", display[1]);
            head.put("rotation", display[2]);
        }
        return xml.getBytes(StandardCharsets.UTF_8);
    }

    /** False when the screen was still changing at the deadline. */
    private boolean waitForIdle(long idle, long deadline) {
        long left = deadline - SystemClock.uptimeMillis();
        if (left <= 0) return false;
        try {
            automation.ui.waitForIdle(Math.min(idle, left), left);
            return true;
        } catch (TimeoutException e) {
            return false;
        }
    }

    private String activeWindowPackage() {
        android.view.accessibility.AccessibilityNodeInfo root = automation.ui.getRootInActiveWindow();
        CharSequence pkg = root != null ? root.getPackageName() : null;
        return pkg != null ? pkg.toString() : "";
    }

    private byte[] screenshot(JSONObject req, JSONObject head) throws Exception {
        Bitmap shot = automation.ui.takeScreenshot();
        if (shot == null) throw new IllegalStateException("takeScreenshot returned nothing");
        head.put("screenWidth", shot.getWidth());
        head.put("screenHeight", shot.getHeight());
        int width = req.optInt("width", 0);
        if (width > 0 && width < shot.getWidth()) {
            int height = Math.round(shot.getHeight() * (float) width / shot.getWidth());
            Bitmap scaled = Bitmap.createScaledBitmap(shot, width, height, true);
            shot.recycle();
            shot = scaled;
        }
        int grid = req.optInt("grid", 0);
        if (grid > 0) shot = Grid.draw(shot, grid);
        boolean jpeg = "jpeg".equals(req.optString("format"));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(512 * 1024);
        shot.compress(jpeg ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG,
                req.optInt("quality", 85), bytes);
        head.put("width", shot.getWidth());
        head.put("height", shot.getHeight());
        head.put("format", jpeg ? "jpeg" : "png");
        shot.recycle();
        return bytes.toByteArray();
    }

    private JSONObject error(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message);
        } catch (JSONException ignored) { }
        return o;
    }

    private void reply(OutputStream out, JSONObject head, byte[] body) throws IOException {
        try {
            head.put("token", token);
            head.put("serial", serial);
        } catch (JSONException ignored) { }
        out.write((head.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        if (body != null) out.write(body);
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(256);
        int b;
        while ((b = in.read()) != -1 && b != '\n') {
            line.write(b);
            if (line.size() > 1 << 20) throw new IOException("request line too long");
        }
        return new String(line.toByteArray(), StandardCharsets.UTF_8);
    }
}
