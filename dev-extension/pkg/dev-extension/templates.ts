/**
 * The templates a workspace can be created from, and the sections of the sidebar.
 *
 * The harness's templates are a repo to clone and an install to run; here a template is the
 * container a workspace's pod runs, because that is the same decision expressed in Kubernetes.
 * They are a hardcoded list rather than something read out of the cluster on purpose: a
 * template is code (a command, a port, what the terminal lands in), and a ConfigMap of them
 * would only move that code somewhere it cannot be reviewed.
 *
 * There is one, and it is the one the product exists for: a rancher/dashboard dev environment,
 * which is what a RANCHER project is in the harness. The toy templates it replaced (busybox, a
 * node placeholder, an nginx page) proved the plumbing and had nothing to do with the work.
 *
 * There is no Rancher server here, and there does not need to be one. A Rancher server per
 * workspace cannot run in this cluster: rancher/rancher with a ServiceAccount token tries to
 * take over the cluster it is in, and without one its embedded k3s is killed within seconds
 * because a privileged pod here gets the node's own cgroup root rather than a namespace of its
 * own. It is also unnecessary: the workspace is already inside a Rancher, and
 * `https://rancher.cattle-system.svc` answers from any pod in this cluster, so the dev server
 * points at that.
 */
/**
 * One secret the product needs, declared rather than hardcoded into a form.
 *
 * Settings is generated from these, so adding a secret is a data change in the same way adding a
 * template is. The declaration carries everything the page needs to render a field for it and
 * everything a card needs to say why it cannot work without it.
 */
export interface DevSecret {
  /**
   * The key inside the one Secret. A global one is the bare key (`GH_TOKEN`); a template's own is
   * stored under the template's own prefix, which the store adds rather than the declaration.
   */
  key: string;
  label: string;
  /** One sentence, shown under the field, saying what the value is and where to get it. */
  help: string;
  /** Whether the thing that declared it can work at all without it. */
  required: boolean;
  /**
   * The product makes this one up rather than asking for it.
   *
   * An admin password for a sidecar that nobody outside this cluster will ever use is a value
   * that has to exist and that nobody has an opinion about, so it is generated once and kept, the
   * way the closet chart's `randAlphaNum` plus `lookup` does it. Settings shows it rather than
   * asking for it, because a generated password you cannot read is one you cannot log in with.
   */
  generated?: boolean;
}

/**
 * An optional container a workspace can run beside itself: a Deployment, and a Service when it
 * serves something. Declared by the template so the Sidecars tab renders from data.
 */
export interface DevSidecar {
  id: string;
  /** The card's section heading, taken from the data rather than a fixed list. */
  group: string;
  label: string;
  description: string;
  image: string;
  /** Overrides the image's entrypoint and arguments, where the image needs it. */
  command?: string[];
  args?: string[];
  /** What its Service points at, when it serves a UI or an API. Omitted when it serves nothing. */
  port?: number;
  env?: Record<string, string>;
  /**
   * Keys from this template's own secret declarations that this sidecar needs, arriving as
   * environment by reference under the key's own name. A sidecar whose key is not set says so on
   * its card and cannot be started, rather than starting and answering nothing.
   */
  secrets?: string[];
  /**
   * The same values again under another environment variable's name.
   *
   * Images rename their variables: Keycloak 26 reads `KC_BOOTSTRAP_ADMIN_PASSWORD` where earlier
   * versions read `KEYCLOAK_ADMIN_PASSWORD`, and the closet chart sets both so that one image
   * works either way. This is how a declaration says that without a second copy of the value.
   */
  secretEnv?: Record<string, string>;
}

export interface DevTemplate {
  /** Stored on the namespace as a label, so the list can say what a workspace was made from. */
  id: string;
  label: string;
  description: string;
  image: string;
  /** Overrides the image's entrypoint. Omitted where the image already runs a server. */
  command?: string[];
  /** What the Service points at. */
  port: number;
  /**
   * How to speak to that port. The apiserver's service proxy takes the scheme as part of the
   * path (`https:name:port`), and rancher/dashboard's dev server is HTTPS, so getting this
   * wrong is a Browser tab that frames a connection error and a probe that never passes.
   */
  scheme?: 'http' | 'https';
  /** The section icon in the sidebar, from Rancher's own icon font. */
  icon: string;
  /** Where the workspace keeps a checkout and its node_modules between restarts. */
  hostPath?: string;
  /** Extra environment for the container. */
  env?: Record<string, string>;
  /**
   * What the Conversations tab actually lands you in.
   *
   * In the harness it is always claude, because every project is built from an image that has
   * it. Here a template chooses its own image, and the small ones cannot host it: claude is a
   * global npm package, so an image needs node and a package manager, which busybox and
   * nginx:alpine do not have. Declared rather than probed, and shown on the tab, because a
   * Conversations tab that quietly turns out to be a plain shell is a thing someone reports as
   * a bug six weeks later.
   *
   * Nothing installs claude into a workspace yet, so this is 'shell' today even on an image
   * that could host it. What is missing is not the install, which is seconds, but the shared
   * login: the pull script lives in the dev server pod's own ConfigMap, and a workspace in
   * another namespace cannot mount it. The field exists so the tab tells the truth now, and so
   * that the template which does install it changes one word rather than a component.
   */
  conversations: 'claude' | 'shell';
  /** What this template's workspaces and sidecars need from the secret store. */
  secrets?: DevSecret[];
  /** The optional containers a workspace of this template can run beside itself. */
  sidecars?: DevSidecar[];
}

/**
 * The secrets that belong to no template.
 *
 * One list, next to the templates' own, because Settings renders both from the same declarations
 * and the only difference between them is the prefix the store puts on the key.
 */
export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    help:     'A personal access token with repo and read:user. My Work reads your issues and pull requests with it, from the browser.',
    required: false,
  },
];

export const TEMPLATES: DevTemplate[] = [
  {
    id:            'rancher',
    label:         'Rancher',
    description:   'A rancher/dashboard checkout with its dependencies installed and the dev server running, pointed at the Rancher this cluster belongs to. The first boot is minutes: a clone, a yarn install and a first compile, and the workspace says which of them it is in.',
    // Plain node rather than a built image, for the reason the dev server this extension runs
    // in uses one: there is nothing to publish and nothing that can be older than the source.
    image:         'node:24',
    icon:          'icon-code',
    port:          8005,
    // The dev server is told to serve plain http (see workspace-config.ts): Rancher's proxy
    // terminates TLS and will not talk to the shell's self-signed dev certificate on the way
    // through, so https here is a proxy error rather than more security.
    scheme:        'http',
    conversations: 'shell',
    // The checkout and node_modules, kept across restarts. Without it every restart is another
    // clone and another install, which is the difference between a workspace and a demo.
    hostPath:      '/var/lib/rancher/dev-workspaces',
    env:           {
      // What the dashboard talks to. The in-cluster Service for the Rancher this pod is
      // already inside, so nothing here has to know a hostname.
      API:          'https://rancher.cattle-system.svc',
      NODE_OPTIONS: '--max_old_space_size=4096',
      // Where this dev server is reached, which its config turns into the router base, the
      // websocket path and the rest. `{{proxyPath}}` is substituted when the Deployment is
      // written, because the path contains the workspace's own name.
      DEV_PROXY_PATH: '{{proxyPath}}',
    },
    secrets: [
      {
        key:      'FIGMA_API_KEY',
        label:    'Figma API key',
        help:     'A personal access token from Figma. The Figma sidecar reads design files with it, and cannot be started without it.',
        required: true,
      },
      // Generated rather than asked for, and generated once. The closet chart makes exactly
      // these two the same way (randAlphaNum, kept across upgrades by a lookup), because they are
      // values that have to exist, that nobody has an opinion about, and that a person still has
      // to be able to read in order to log in to the sidecar they belong to.
      {
        key:       'KEYCLOAK_ADMIN_PASSWORD',
        label:     'Keycloak admin password',
        help:      'The password for Keycloak\'s own admin user. Generated the first time Keycloak is started and kept, so a realm you configure survives a restart.',
        required:  true,
        generated: true,
      },
      {
        key:       'OPENLDAP_ADMIN_PASSWORD',
        label:     'OpenLDAP admin password',
        help:      'The password for cn=admin. Generated the first time OpenLDAP is started and kept, since the directory it protects is on a volume that outlives the pod.',
        required:  true,
        generated: true,
      },
    ],
    // Every image here was started in this cluster and reached Ready before it was given a
    // card. What is deliberately absent is a Rancher server: it cannot reach Running here (see
    // the note above), so it must not appear as something a person can press Start on.
    sidecars: [
      {
        id:          'keycloak',
        group:       'Auth',
        label:       'Keycloak',
        description: 'OIDC and SAML identity provider, for signing in to the dashboard as somebody other than admin.',
        image:       'quay.io/keycloak/keycloak:26.0',
        args:        ['start-dev'],
        port:        8080,
        env:         {
          KEYCLOAK_ADMIN: 'admin', KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_HTTP_PORT: '8080'
        },
        secrets:   ['KEYCLOAK_ADMIN_PASSWORD'],
        // 26 reads the KC_BOOTSTRAP_ name and warns about the other; both are set so the
        // declaration does not have to be revised the next time the image renames it.
        secretEnv: { KC_BOOTSTRAP_ADMIN_PASSWORD: 'KEYCLOAK_ADMIN_PASSWORD' },
      },
      {
        id:          'openldap',
        group:       'Auth',
        label:       'OpenLDAP',
        description: 'LDAP directory server, for testing the dashboard against a directory rather than local users.',
        image:       'osixia/openldap:1.5.0',
        port:        389,
        env:         {
          LDAP_ORGANISATION: 'dev', LDAP_DOMAIN: 'dev.local', LDAP_TLS: 'false'
        },
        secrets:   ['OPENLDAP_ADMIN_PASSWORD'],
        secretEnv: { LDAP_ADMIN_PASSWORD: 'OPENLDAP_ADMIN_PASSWORD' },
      },
      {
        id:          'figma',
        group:       'Design',
        label:       'Figma',
        description: 'Figma MCP server, so a conversation in this workspace can read the design a change is meant to match.',
        image:       'acuvity/mcp-server-figma:latest',
        port:        3000,
        secrets:     ['FIGMA_API_KEY'],
      },
    ],
    command: [
      '/bin/sh',
      '-c',
      [
        'set -e',
        'cd /workspace',
        // Each step is guarded by what it produces, so a restart resumes rather than repeats.
        '[ -d dashboard/.git ] || git clone --depth 1 https://github.com/rancher/dashboard dashboard',
        'cd dashboard',
        '[ -f .install-done ] || (yarn install --network-timeout 600000 && touch .install-done)',
        // The checkout is an ordinary clone, so its own config is the one that assumes a dev
        // server on its own origin. It is kept, under the name the shipped one requires, and
        // wrapped: see workspace-config.ts.
        //
        // The repo's copy is restored from git first, every boot. Guarding on the presence of
        // the .orig instead is what breaks on the second boot: the file in the tree is by then
        // the wrapper, and the guard saves the wrapper as the original, which then requires
        // itself. Restoring makes this idempotent and repairs a checkout that has already been
        // through that.
        'git checkout -- vue.config.js || true',
        'cp vue.config.js vue.config.orig.js',
        'cp /dev-config/vue.config.js vue.config.js',
        'exec yarn dev --port 8005',
      ].join(' && '),
    ],
  },
];

export function templateById(id: string): DevTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
