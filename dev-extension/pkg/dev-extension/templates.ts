/**
 * The templates a workspace can be created from.
 *
 * The harness's templates are a repo to clone and an install to run; here a template is the
 * container a workspace's pod runs, because that is the same decision expressed in Kubernetes.
 * They are a hardcoded list rather than something read out of the cluster on purpose: a
 * template is code (a command, a port, what the terminal lands in), and a ConfigMap of them
 * would only move that code somewhere it cannot be reviewed.
 *
 * Every template serves something on a port, so the Service each workspace gets is real rather
 * than decorative. The images are ones this cluster already runs or can pull quickly, since a
 * workspace that spends five minutes pulling is one you cannot tell from a broken one.
 */
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
   * What the Conversations tab actually lands you in.
   *
   * In the harness it is always claude, because every project is built from an image that has
   * it. Here a template chooses its own image, and the small ones cannot host it: claude is a
   * global npm package, so an image needs node and a package manager, which busybox and
   * nginx:alpine do not have. Declared rather than probed, and shown on the tab, because a
   * Conversations tab that quietly turns out to be a plain shell is a thing someone reports as
   * a bug six weeks later.
   *
   * Nothing installs claude yet, so every template here is 'shell' today. The field exists so
   * that the tab tells the truth now, and so that the template that does install it changes one
   * word rather than a component.
   */
  conversations: 'claude' | 'shell';
}

export const TEMPLATES: DevTemplate[] = [
  {
    id:            'shell',
    label:         'Shell',
    description:   'BusyBox: an ash shell and not much else. The smallest thing that is still a workspace, and the one to pick when what you want is a terminal in the cluster.',
    // busybox rather than alpine, which looks like the same thing and is not: alpine builds
    // its busybox without the httpd applet (it ships in busybox-extras), so the container
    // exits with "httpd: not found" and the workspace never leaves Starting.
    image:         'busybox:1.36',
    command:       [
      '/bin/sh',
      '-c',
      'mkdir -p /www && echo "<h1>shell</h1>" > /www/index.html && exec httpd -f -p 8080 -h /www',
    ],
    port:          8080,
    conversations: 'shell',
  },
  {
    id:            'node',
    label:         'Node 24',
    description:   'Node 24 with yarn and a shell, serving a placeholder on 8080. The closest of these to what the Claude Harness, which this is a port of, calls a rancher-dashboard project.',
    image:         'node:24',
    command:       [
      '/bin/sh',
      '-c',
      'exec node -e "require(\'http\').createServer((req, res) => res.end(\'node workspace\\n\')).listen(8080)"',
    ],
    port:          8080,
    conversations: 'shell',
  },
  {
    id:            'static-site',
    label:         'Static site',
    description:   'Nginx serving its default page on 80. Nothing to configure, so it is the one to reach for when you want to prove the plumbing rather than the container.',
    image:         'nginx:alpine',
    port:          80,
    conversations: 'shell',
  },
];

export function templateById(id: string): DevTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
