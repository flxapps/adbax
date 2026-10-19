// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.os.Looper;

/**
 * Entry point, started by the host through app_process as the shell user:
 *
 *   CLASSPATH=/data/local/tmp/adbax-server.jar app_process / --nice-name=adbax-server \
 *       es.flx.adbax.Main --socket adbax --token <jar md5> --serial <adb serial> --idle 600
 *
 * The main thread only runs a Looper. Some UiAutomation constructors post their
 * connection handshake to the main looper, so connecting from the main thread
 * before it loops would wait on itself.
 */
public final class Main {
    public static void main(String[] args) {
        String socket = "adbax";
        String token = "";
        String serial = "";
        long idleSeconds = 600;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if (i + 1 < args.length && a.equals("--socket")) socket = args[++i];
            else if (i + 1 < args.length && a.equals("--token")) token = args[++i];
            else if (i + 1 < args.length && a.equals("--serial")) serial = args[++i];
            else if (i + 1 < args.length && a.equals("--idle")) idleSeconds = Long.parseLong(args[++i]);
        }

        Looper.prepareMainLooper();
        final Server server = new Server(socket, token, serial, idleSeconds * 1000L);
        Thread worker = new Thread(new Runnable() {
            @Override public void run() {
                int code = 0;
                try {
                    server.run();
                } catch (Throwable t) {
                    System.err.println("adbax-server: " + t);
                    t.printStackTrace();
                    code = 1;
                }
                System.exit(code);
            }
        }, "adbax-server");
        worker.start();
        Looper.loop();
    }

    private Main() {}
}
