/**
 * dev-mode toggle
 * true  = using LOCAL_GATEWAY
 * false = using hosted GATEWAY
 */
const DEV_USE_LOCAL_GATEWAY = false;


/**
 * Reads a required environment variable from Vite's import.meta.env.
 * Throws an error if the variable is missing so configuration issues
 * are detected early during startup.
 */
function requireEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

/**
 * Strongly typed telemetry configuration.
 *
 * Configuration source depends on DEV_USE_LOCAL_GATEWAY:
 *
 *  - DEV_USE_LOCAL_GATEWAY = false
 *      Uses HARD-CODED backend gateway values
 *      (shared test / production-like environment).
 *
 *  - DEV_USE_LOCAL_GATEWAY = true
 *      Uses LOCAL gateway configuration resolved from environment variables:
 *        - VITE_GATEWAY_URL        : Local telemetry gateway base URL
 *        - VITE_TELEMETRY_HUB_PATH : Local SignalR hub path
 *
 * Optional environment variables:
 *  - VITE_DEFAULT_DEVICE_ID : Default device ID used when none is provided
 */
export const telemetryConfig = {
  gatewayUrl: !DEV_USE_LOCAL_GATEWAY
    ? "https://example.invalid:5050"
    : requireEnv("VITE_GATEWAY_URL"),

  telemetryHubPath: !DEV_USE_LOCAL_GATEWAY
    ? "/monitoring-broadcast"
    : requireEnv("VITE_TELEMETRY_HUB_PATH"),

  defaultDeviceId:
    import.meta.env.VITE_DEFAULT_DEVICE_ID ?? "WebAppDevice001",
};

/**
 * Joins a base URL and a path into a single normalized URL.
 * It safely handles trailing slashes on the base and leading slashes on the path
 * so that the resulting URL does not contain duplicate or missing slashes.
 *
 * Examples:
 *  joinUrl("https://example.com/", "/telemetryHub") -> "https://example.com/telemetryHub"
 *  joinUrl("https://example.com", "telemetryHub")   -> "https://example.com/telemetryHub"
 */
function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Precomputed URLs used by the telemetry frontend.
 * These are derived from the base configuration so that components
 * only need to import a single object to connect to the hub.
 */
export const telemetryUrls = {
  /** Full URL to the SignalR telemetry hub endpoint */
  telemetryHub: joinUrl(
    telemetryConfig.gatewayUrl,
    telemetryConfig.telemetryHubPath
  ),
};
