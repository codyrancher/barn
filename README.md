# barn, as a Rancher extension repository

This branch is not source. It is the Helm repository that Rancher installs barn from, and
everything on it is written by CI: `.github/workflows/build-extension-charts.yml` on `main`
builds the extension on a release and commits the result here.

```
index.yaml                 the Helm repository index Rancher reads
assets/barn/*.tgz          the packaged charts it points at
charts/barn/<version>/     those charts, unpacked, for chart-releaser
extensions/barn/<version>/ the built extension itself, fetched by the browser
```

## Installing it

In Rancher, under **Apps -> Repositories**, add this repository's Pages URL as an `http(s)`
repository. Barn then appears under **Extensions**.

The URL is `https://<owner>.github.io/barn/`, and it only answers if the repository is public
(or on a plan whose Pages are public). Rancher fetches the index from Pages and the extension's
own files from `raw.githubusercontent.com`, carrying no credential belonging to whoever is
installing it, so a private repository publishes successfully and then serves 404 to everyone.

## The other kind of publishing

The **Publish** button in barn's editor is a different thing and does not touch this branch: it
builds the extension in its own pod, serves the bundle from that pod, and installs it into the
Rancher in front of you. That is a dev loop, and what it installs lives exactly as long as the
pod does. This branch is how the extension outlives it.
