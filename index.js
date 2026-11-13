// Cloudflare front door for Agula Terminal.
// All the application logic is Python (agula.py) running inside the container;
// this Worker only starts that container and forwards every request to it.
import { Container, getContainer } from "@cloudflare/containers";

export class AgulaContainer extends Container {
  defaultPort = 8080;      // agula.py listens here (see Dockerfile)
  sleepAfter = "30m";      // stop after 30 idle minutes; the next visit starts it again (a few seconds)
  enableInternet = true;   // needed to reach Yahoo Finance, Cboe, the US Treasury, FRED, Binance and Google News

  constructor(ctx, env) {
    super(ctx, env);
    // Secrets set with `npx wrangler secret put NAME` reach the Python app as environment variables.
    this.envVars = {
      PORT: "8080",
      NO_BROWSER: "1",
      AGULA_IP_HEADER: "cf-connecting-ip",          // real visitor IP for the per-visitor rate limit
      AGULA_CACHE_DIR: "/tmp/agula-cache",
      AGULA_RATE_LIMIT: env.AGULA_RATE_LIMIT || "600",
      FRED_API_KEY: env.FRED_API_KEY || "",
      AGULA_BOT_TOKEN: env.AGULA_BOT_TOKEN || "",    // protects the paper-trading bots (npx wrangler secret put AGULA_BOT_TOKEN)
      AGULA_DATA_DIR: "/tmp/agula-data",             // container disk is temporary; bots are also backed up in each browser
    };
  }
}

export default {
  async fetch(request, env) {
    // Always the same named instance, so all visitors share one warm cache.
    const agula = getContainer(env.AGULA, "main");
    try {
      return await agula.fetch(request);
    } catch (err) {
      return new Response(
        "Agula Terminal is starting up. Refresh in a few seconds.\n\n" + String(err),
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" } },
      );
    }
  },
};
