// Dev server config for the pod. Seeded to /app/vue.config.js, so `__dirname` is the app.
//
// The browser reaches this server through the Kubernetes apiserver's service proxy, on
// Rancher's own origin:
//
//   https://<rancher>/k8s/clusters/local/api/v1/namespaces/<ns>/services/http:<svc>:8005/proxy/
//
// That inverts the shell's dev server defaults in three ways. Every URL this build hands to
// the browser has to carry the proxy prefix, every request that arrives has had it stripped
// again by the proxy, and the TLS the browser sees is Rancher's, not this server's.
//
// DEV_PROXY_PATH is the only thing passed in. It is built by the extension out of the same
// namespace/service/port constants it creates the Deployment and Service with, so this build
// never learns - and never needs - the hostname Rancher is served on.
const proxyPath = process.env.DEV_PROXY_PATH;

if (!proxyPath) {
  throw new Error('DEV_PROXY_PATH must be set - it is the service-proxy path this dev server is reached at');
}

// The vue-router base: the prefix on every in-app link, which has to be the path the page
// was loaded at. The shell reads it out of the environment when its exported function runs;
// setting it above the require means that cannot matter. RESOURCE_BASE, the other half of
// that pair, is deliberately left unset - asset URLs are handled below instead.
process.env.ROUTER_BASE = `${ proxyPath }/`;

const config = require('@rancher/shell/vue.config'); // eslint-disable-line @typescript-eslint/no-var-requires

const base = config(__dirname, { excludes: [] });

// Asset URLs, and why they are not simply the proxy path.
//
// The apiserver's service proxy rewrites absolute URLs in HTML responses, prepending its own
// proxy path - it is what lets a naive web UI work behind it at all. So an asset URL that
// already carried the proxy path comes back to the browser carrying it twice.
//
// Both halves of this use that rewriting rather than fight it:
//
//  - index.html asks for `/js/index.js`, and the proxy hands the browser
//    `<proxy>/js/index.js`. Absolute, so it does not depend on which route the page was
//    loaded at, the way a relative URL would.
//  - webpack's runtime publicPath is `auto`, which it works out from its own script URL when
//    it loads. So chunks, fonts and images fetched later land on the same base, and nothing
//    has to be told what that base is.
base.publicPath = 'auto';

const previousChainWebpack = base.chainWebpack;

base.chainWebpack = (webpackConfig) => {
  if (typeof previousChainWebpack === 'function') {
    previousChainWebpack(webpackConfig);
  }

  // html-webpack-plugin has a publicPath of its own, which is what makes the two halves
  // above able to disagree. `html-index` is the plugin's name because the shell's config
  // declares an `index` page.
  webpackConfig.plugin('html-index').tap((args) => {
    args[0].publicPath = '/';

    return args;
  });
};

base.devServer = {
  ...base.devServer,

  // Rancher's proxy terminates TLS, and it will not talk to the shell's self-signed dev
  // certificate on the way through. Plain http here, https to the browser.
  server: { type: 'http' },

  // Requests arrive with whatever Host the proxy chain last set, never this server's own.
  allowedHosts: 'all',

  // No gzip. The proxy rewrites URLs in HTML responses as they pass through (see below),
  // and it cannot do that to a compressed body: the request comes back as
  // `stream error: ...; INTERNAL`, which the browser reports as an incomplete response and
  // a blank page. webpack-dev-server compresses by default, so this has to be said.
  compress: false,

  // The proxy strips its prefix before a request lands here, so everything this server
  // serves is served from the root: webpack's output, and the files in public/.
  devMiddleware: { publicPath: '/' },
  static:        { publicPath: '/' },

  // Serve index.html for any path that is not a file, so a deep link into the dashboard
  // (rather than its root) loads the app instead of 404ing. vue-cli installs a version of
  // this derived from publicPath, which is `auto` here and therefore no use; setting it at
  // all replaces theirs outright. disableDotRule matters more than usual in Rancher, where
  // routes routinely carry a resource name with dots in it.
  historyApiFallback: {
    index:             '/index.html',
    disableDotRule:    true,
    htmlAcceptHeaders: ['text/html', 'application/xhtml+xml']
  },

  // Hot reload rides the same proxy: the apiserver passes the upgrade through, so webpack's
  // own client works unmodified. The sentinels are webpack-dev-server's "infer it from
  // window.location" values (protocol 'auto', hostname '0.0.0.0', port 0) - only the path is
  // ours. The socket needs a Rancher session because the proxy does, which is the one place
  // this shows: hot reload works on every page you are logged in for, not on the login page.
  hot:             true,
  webSocketServer: { type: 'ws', options: { path: '/ws' } },
  client:          {
    webSocketURL: {
      protocol: 'auto',
      hostname: '0.0.0.0',
      port:     0,
      pathname: `${ proxyPath }/ws`
    },
    // The full-screen compile-error overlay is the dev build's, so it would cover this
    // dashboard entirely for whoever happens to be looking when an edit fails to compile.
    overlay: false
  }
};

// The API the shell's dev server proxies to is deliberately left at its default. The browser
// is same-origin with Rancher here, so every /v1, /k8s and /rancherversion request it makes
// goes straight to Rancher and never through this server - the proxy config exists for a dev
// server on its own origin, which this one is not.

// The shell ships /node_modules/ in watchOptions.ignored, which makes its own pages (login,
// nav, anything outside pkg/) impossible to edit live. Watching @rancher/shell and ignoring
// the rest is what makes the whole dashboard editable in the pod, not just the extension.
const previousConfigureWebpack = base.configureWebpack;

base.configureWebpack = (config) => {
  const result = typeof previousConfigureWebpack === 'function'
    ? previousConfigureWebpack(config)
    : previousConfigureWebpack;

  config.watchOptions = {
    ...(config.watchOptions || {}),
    ignored: /node_modules\/(?!@rancher\/shell)/
  };

  // Watching is not enough on its own. Webpack 5 treats node_modules as a "managed path" and
  // assumes its contents never change, so it caches them and skips the watcher entirely.
  // Clearing that is what actually makes an edit under @rancher/shell rebuild.
  config.snapshot = {
    ...(config.snapshot || {}),
    managedPaths:   [],
    immutablePaths: []
  };

  return result;
};

module.exports = base;
