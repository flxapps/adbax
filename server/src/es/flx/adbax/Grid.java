// SPDX-License-Identifier: Apache-2.0
package es.flx.adbax;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;

/**
 * A coordinate grid over a screenshot, labelled in the screenshot's own
 * pixels. For screens without accessibility nodes (games, canvases, video) a
 * model reads positions off the labels instead of estimating them.
 *
 * The labels are stroked seven-segment digits rather than text: an
 * app_process has no font setup, and on Android 8 drawing text there aborts
 * the process.
 */
final class Grid {
    private Grid() {}

    // Segments a-g as {x1, y1, x2, y2} in a 1x2 cell.
    private static final float[][] SEGMENTS = {
        {0, 0, 1, 0}, {1, 0, 1, 1}, {1, 1, 1, 2}, {0, 2, 1, 2}, {0, 1, 0, 2}, {0, 0, 0, 1}, {0, 1, 1, 1},
    };
    private static final String[] DIGITS = {
        "abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgecd", "abc", "abcdefg", "abcdfg",
    };

    static Bitmap draw(Bitmap src, int step) {
        Bitmap out = src.isMutable() && src.getConfig() == Bitmap.Config.ARGB_8888
                ? src : src.copy(Bitmap.Config.ARGB_8888, true);
        if (out != src) src.recycle();
        Canvas c = new Canvas(out);
        int w = out.getWidth();
        int h = out.getHeight();

        Paint dark = new Paint();
        dark.setColor(0x99000000);
        Paint light = new Paint();
        light.setColor(0x99FFFFFF);
        // A dark line with a light twin one pixel over shows on any background.
        for (int x = step; x < w; x += step) {
            float sw = x % (step * 5) == 0 ? 2 : 1;
            dark.setStrokeWidth(sw);
            light.setStrokeWidth(sw);
            c.drawLine(x, 0, x, h, dark);
            c.drawLine(x + 1, 0, x + 1, h, light);
        }
        for (int y = step; y < h; y += step) {
            float sw = y % (step * 5) == 0 ? 2 : 1;
            dark.setStrokeWidth(sw);
            light.setStrokeWidth(sw);
            c.drawLine(0, y, w, y, dark);
            c.drawLine(0, y + 1, w, y + 1, light);
        }

        float cell = Math.max(3, step / 12f);
        Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        halo.setColor(0xFFFFFFFF);
        halo.setStrokeWidth(cell * 0.9f);
        halo.setStrokeCap(Paint.Cap.ROUND);
        Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
        ink.setColor(0xFFD50000);
        ink.setStrokeWidth(Math.max(1.5f, cell * 0.4f));
        ink.setStrokeCap(Paint.Cap.ROUND);
        // Every other intersection, so labels never touch.
        for (int y = step; y < h; y += step) {
            for (int x = step; x < w; x += step) {
                if ((x / step + y / step) % 2 != 0) continue;
                String label = x + "," + y;
                float top = y - cell * 2 - cell;
                label(c, label, x + cell, top, cell, halo);
                label(c, label, x + cell, top, cell, ink);
            }
        }
        return out;
    }

    private static void label(Canvas c, String s, float x, float y, float cell, Paint p) {
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == ',') {
                c.drawLine(x + cell * 0.3f, y + cell * 2, x, y + cell * 2.6f, p);
                x += cell * 0.9f;
                continue;
            }
            for (char seg : DIGITS[ch - '0'].toCharArray()) {
                float[] s4 = SEGMENTS[seg - 'a'];
                c.drawLine(x + s4[0] * cell, y + s4[1] * cell, x + s4[2] * cell, y + s4[3] * cell, p);
            }
            x += cell * 1.7f;
        }
    }
}
