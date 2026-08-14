/**
 * The vue.config.js a workspace's dashboard dev server runs with.
 *
 * This is the same problem this extension's own pod already solved, one level out. A
 * rancher/dashboard dev server reached through the Kubernetes apiserver's service proxy is not
 * being reached the way its defaults assume: the Host header is the proxy's, the TLS the
 * browser sees is Rancher's, every request arrives with the proxy prefix already stripped, and
 * every URL handed back to the browser has to carry it again.
 *
 * The evidence that this is needed rather than theoretical: without it the proxy answers
 * `Invalid Host header`, which is webpack's dev server refusing the request, and the Browser
 * tab frames that instead of the dashboard.
 *
 * It is kept here as text rather than as a file because it has to end up inside a container
 * this code only ever talks to through the API. It is written into a ConfigMap in the
 * workspace's namespace and copied into the checkout on boot, beside the repo's own config,
 * which it wraps rather than replaces: a workspace is still an ordinary clone of
 * rancher/dashboard that someone can work in, and its config is still the repo's.
 *
 * The annotated original, with the reasoning for each option, is
 * `rancher-extension/dev-extension/pod/vue.config.js`. Keep the two in step.
 */
export const WORKSPACE_VUE_CONFIG = `// Written by the Dev extension. See pkg/dev-extension/workspace-config.ts.
//
// This dev server is reached at DEV_PROXY_PATH, through the apiserver's service proxy, on
// Rancher's own origin. Everything below is that fact and its consequences.
const proxyPath = (process.env.DEV_PROXY_PATH || '').replace(/\\/$/, '');

if (!proxyPath) {
  throw new Error('DEV_PROXY_PATH must be set - it is the service-proxy path this dev server is reached at');
}

// The prefix on every in-app link, which has to be the path the page was loaded at. Set before
// the shell's config runs, because the shell reads it out of the environment as it does.
process.env.ROUTER_BASE = proxyPath + '/';

// The repo's own config, kept beside this one on boot, rather than a reimplementation of it.
// rancher/dashboard is a monorepo whose shell is ./shell rather than a node_modules package,
// and which arguments its root config passes to that shell is the repo's business and changes
// with the repo. Wrapping it means this file only has to know about the proxy.
const base = require('./vue.config.orig.js');

// The proxy rewrites absolute URLs in HTML as they pass through, which is what lets a naive UI
// work behind it at all, so an asset URL that already carried the prefix would carry it twice.
// index.html therefore asks for '/js/...' and lets the proxy add the prefix, while webpack's
// runtime works its own base out from the script URL it was loaded from.
base.publicPath = 'auto';

const previousChainWebpack = base.chainWebpack;

base.chainWebpack = (webpackConfig) => {
  if (typeof previousChainWebpack === 'function') {
    previousChainWebpack(webpackConfig);
  }

  webpackConfig.plugin('html-index').tap((args) => {
    args[0].publicPath = '/';

    return args;
  });
};

base.devServer = {
  ...base.devServer,

  // Rancher's proxy terminates TLS and will not talk to the shell's self-signed dev
  // certificate on the way through. Plain http here, https to the browser.
  server: { type: 'http' },

  // Requests arrive with whatever Host the proxy chain last set, never this server's own.
  // Without this the proxy answers 'Invalid Host header'.
  allowedHosts: 'all',

  // The proxy cannot rewrite URLs in a compressed body: the response comes back as a stream
  // error and the browser shows a blank page.
  compress: false,

  // The prefix is stripped before a request lands here, so everything is served from the root.
  devMiddleware: { publicPath: '/' },
  static:        { publicPath: '/' },

  // A deep link into the dashboard has to load the app rather than 404. disableDotRule matters
  // in Rancher, where a route routinely carries a resource name with dots in it.
  historyApiFallback: {
    index:             '/index.html',
    disableDotRule:    true,
    htmlAcceptHeaders: ['text/html', 'application/xhtml+xml']
  },

  // Hot reload rides the same proxy. The sentinels are webpack-dev-server's own "infer it from
  // window.location" values; only the path is ours.
  hot:             true,
  webSocketServer: { type: 'ws', options: { path: '/ws' } },
  client:          {
    webSocketURL: {
      protocol: 'auto',
      hostname: '0.0.0.0',
      port:     0,
      pathname: proxyPath + '/ws'
    },
    // The compile-error overlay would cover the whole framed dashboard for whoever is looking
    // when an edit fails to compile.
    overlay: false
  }
};

module.exports = base;
`;

/** Where the ConfigMap holding it is mounted, and what the workspace copies it from. */
export const WORKSPACE_CONFIG_MOUNT = '/dev-config';
