// SPDX-License-Identifier: Apache-2.0
import { idleSeconds } from '../backends/server.js';
import { fail } from '../util.js';

/** adbax server [status|start|stop|restart|log] */
export async function server(ctx) {
  const sub = ctx.pos[0] || 'status';
  const dev = await ctx.device();
  const s = dev.server;
  switch (sub) {
    case 'status': {
      const st = await s.status();
      if (!st.running) {
        return ctx.out(st.pid ? `pid ${st.pid} is up but not answering on a forward; \`adbax server restart\`` : 'not running');
      }
      const p = st.ping;
      return ctx.out(`running: pid ${p.pid}, sdk ${p.sdk}, up ${Math.round(p.uptimeMs / 1000)}s, port ${st.port}` +
        (st.current ? '' : ', older build (replaced on next use)'));
    }
    case 'start':
    case 'restart': {
      if (sub === 'restart') await s.stop();
      const head = await s.start({ idle: +(ctx.flags.idle || idleSeconds()), force: true });
      return ctx.out(`started: pid ${head.pid}, sdk ${head.sdk}, exits after ${ctx.flags.idle || idleSeconds()}s idle`);
    }
    case 'stop':
      await s.stop();
      return ctx.out('stopped');
    case 'log':
      return ctx.out((await s.log()).trim() || '(no log)');
    default:
      fail('usage: adbax server [status|start|stop|restart|log] [--idle seconds]');
  }
}
