import { Container, getContainer } from "@cloudflare/containers";

/**
 * Agula Terminal's FastAPI backend runs in the Docker container on port 8080.
 * The Worker forwards both the terminal page and API calls to that backend.
 */
export class AgulaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;
}

export default {
  async fetch(request, env) {
    // One named instance shares the in-memory market data cache.
    const container = getContainer(env.AGULA, "agula-main");
    return container.fetch(request);
  },
};
