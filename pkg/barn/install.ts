// What this extension installs, said once, in the order it is installed.
//
// It was three functions that each created a few objects and swallowed whatever went wrong, so
// the only way to know what barn puts in a cluster was to read them, and the only sign it was
// happening was that the editor eventually worked. This is the same work as a list: what each
// object is, one sentence on why it exists, and where to go and look at it.
//
// The list is the source for three things that used to disagree - the install itself, the
// progress the editor shows, and the uninstall - so a resource added in one place cannot be
// forgotten by the other two.
import {
  EXT_NS, EXT_ACCOUNT, EXT_ROLE_BINDING, BROWSER_OBJECT, BROWSER_SERVICES, BROWSER_PORTS,
  EXT_PORTS, extensionObject, namespaceBody, serviceAccountBody, clusterRoleBindingBody,
  serviceBody, browserServicesBody, browserDeployment, deploymentBody, seedConfigMapBody,
  createIfAbsent, objectExists, refreshBrowserServices,
} from './extensions';

/** Where a step is, as far as anybody watching is concerned. */
export type StepState = 'waiting' | 'checking' | 'creating' | 'done' | 'failed';

export interface InstallStep {
  id: string;
  label: string;
  /** One sentence. What breaks without it, rather than what it is. */
  description: string;
  /** The Steve collection, for reading and creating it. */
  type: string;
  /** The type as Rancher's own UI names it, which is not always the same word. */
  uiType: string;
  namespace?: string;
  name: string;
  body: () => Record<string, unknown>;
  /** Run after the object exists, for the one thing that is kept up to date rather than made once. */
  after?: () => Promise<void>;
}

export interface StepProgress {
  step: InstallStep;
  state: StepState;
  error?: string;
}

/**
 * The cluster-wide half: made once, shared by every extension, and the part that outlives them.
 */
function sharedSteps(): InstallStep[] {
  return [
    {
      id:          'namespace',
      label:       `Namespace ${ EXT_NS }`,
      description: 'Holds everything this extension creates, so uninstalling it is one delete.',
      type:        'namespaces',
      uiType:      'namespace',
      name:        EXT_NS,
      body:        namespaceBody,
    },
    {
      id:          'serviceaccount',
      label:       `ServiceAccount ${ EXT_ACCOUNT }`,
      description: 'The identity every extension pod runs as, and what its terminal acts as.',
      type:        'serviceaccounts',
      uiType:      'serviceaccount',
      namespace:   EXT_NS,
      name:        EXT_ACCOUNT,
      body:        serviceAccountBody,
    },
    {
      id:          'clusterrolebinding',
      label:       `ClusterRoleBinding ${ EXT_ROLE_BINDING }`,
      description: 'Grants that identity cluster-admin, without which a terminal gets 403 to every question about the cluster.',
      type:        'rbac.authorization.k8s.io.clusterrolebindings',
      uiType:      'rbac.authorization.k8s.io.clusterrolebinding',
      name:        EXT_ROLE_BINDING,
      body:        clusterRoleBindingBody,
    },
  ];
}

/** The browser every extension is looked at in. One for the namespace, not one each. */
function browserSteps(): InstallStep[] {
  return [
    {
      id:          'browser-services',
      label:       `ConfigMap ${ BROWSER_SERVICES }`,
      description: 'Two scripts the browser runs: one republishes its debugging port, one keeps its display awake so screenshots do not hang.',
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   EXT_NS,
      name:        BROWSER_SERVICES,
      body:        browserServicesBody,
      after:       refreshBrowserServices,
    },
    {
      id:          'browser-deployment',
      label:       `Deployment ${ BROWSER_OBJECT }`,
      description: 'A Chromium with its debugging protocol open, so an agent can open the page it just changed and see it.',
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   EXT_NS,
      name:        BROWSER_OBJECT,
      body:        browserDeployment,
    },
    {
      id:          'browser-service',
      label:       `Service ${ BROWSER_OBJECT }`,
      description: 'How pods reach that browser, and how a person frames it through Rancher.',
      type:        'services',
      uiType:      'service',
      namespace:   EXT_NS,
      name:        BROWSER_OBJECT,
      body:        () => serviceBody(BROWSER_OBJECT, BROWSER_PORTS),
    },
  ];
}

/** One extension: the tree it is seeded from, the pod that serves it, and the way in. */
export function extensionSteps(name: string, source?: string): InstallStep[] {
  const object = extensionObject(name);

  return [
    {
      id:          `seed-${ name }`,
      label:       `ConfigMap ${ object }`,
      description: `The source ${ name } is seeded from, which is what a fresh pod writes its tree out of.`,
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   EXT_NS,
      name:        object,
      body:        () => seedConfigMapBody(name, source),
    },
    {
      id:          `deployment-${ name }`,
      label:       `Deployment ${ object }`,
      description: `Runs the dev server that compiles ${ name } and pushes every save into the browser.`,
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   EXT_NS,
      name:        object,
      body:        () => deploymentBody(name),
    },
    {
      id:          `service-${ name }`,
      label:       `Service ${ object }`,
      description: `How the dashboard reaches that dev server, through the apiserver's proxy on Rancher's own origin.`,
      type:        'services',
      uiType:      'service',
      namespace:   EXT_NS,
      name:        object,
      body:        () => serviceBody(object, EXT_PORTS),
    },
  ];
}

/** Everything a cluster needs for the editor to open on `name`. */
export function installSteps(name: string, source?: string): InstallStep[] {
  return [...sharedSteps(), ...extensionSteps(name, source), ...browserSteps()];
}

/**
 * Where to go and look at one, in Rancher's own UI.
 *
 * The explorer's own routes rather than anything of ours: `/c/:cluster/:product/:resource` with
 * a namespace and a name on the end when it has them. Somebody curious about what was just
 * created should land on the object itself, not on a list to search.
 */
export function stepLink(step: InstallStep): string {
  const parts = ['/c', 'local', 'explorer', step.uiType];

  if (step.namespace) {
    parts.push(step.namespace);
  }

  parts.push(step.name);

  return parts.join('/');
}

/**
 * Do the install, reporting each step as it goes.
 *
 * Sequential on purpose. The namespace has to exist before anything can be made in it, and an
 * account has to exist before a pod can be told to run as it - and a person watching a list
 * appear all at once learns less than one watching it fill in.
 *
 * Nothing here throws: a step that fails is reported as failed and the rest still run, because
 * one object that could not be made is not a reason to leave the other eight unmade.
 */
export async function runInstall(
  name: string,
  onProgress: (progress: StepProgress[]) => void,
  source?: string,
): Promise<StepProgress[]> {
  const steps = installSteps(name, source);
  const progress: StepProgress[] = steps.map((step) => ({ step, state: 'waiting' as StepState }));
  const report = () => onProgress(progress.map((entry) => ({ ...entry })));

  report();

  for (const entry of progress) {
    try {
      entry.state = 'checking';
      report();

      if (!await objectExists(entry.step)) {
        entry.state = 'creating';
        report();
      }

      await createIfAbsent(entry.step);
      await entry.step.after?.();
      entry.state = 'done';
    } catch (e: any) {
      entry.state = 'failed';
      entry.error = e?.message || String(e);
    }

    report();
  }

  return progress;
}

/** What is already there, without making anything. The editor asks this before it asks to install. */
export async function installState(name: string): Promise<StepProgress[]> {
  const steps = installSteps(name);

  return Promise.all(steps.map(async(step) => ({
    step,
    state: (await objectExists(step) ? 'done' : 'waiting') as StepState,
  })));
}
