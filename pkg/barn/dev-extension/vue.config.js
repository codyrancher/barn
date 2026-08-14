// Dev server config for running DevExtension **locally**, without the pod.
//
// There are two of these and they are for different places. `pod/vue.config.js`
// is the one the pod runs: it is seeded to `/app/vue.config.js` and it exists to
// address a dashboard that is served through the Kubernetes apiserver proxy.
// This one is the ordinary extension dev server, on its own port, for the
// ordinary reason: editing the extension and seeing it, without a sync, a
// ConfigMap or a proxy in the way.
//
//   cd pkg/barn/dev-extension
//   ln -sfn ../node_modules node_modules      # once: the app next door has them
//   NODE_ENV=dev API=https://<rancher> ./node_modules/.bin/vue-cli-service serve --port 8006
//
// node_modules is a symlink rather than an install because this app's
// dependencies are the ones the barn package already has, and an install of
// its own would be several minutes and a gigabyte to say the same thing.
//
// The pod stays the deployment target and the seed stays the source of truth for
// it. This is only a faster place to look at the same code.
module.exports = require('@rancher/shell/vue.config')(__dirname, { excludes: [] });
