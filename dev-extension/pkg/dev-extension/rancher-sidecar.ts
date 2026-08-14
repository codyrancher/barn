/**
 * A real Rancher for a workspace, as `charts/closet/templates/rancher.yaml` already does it.
 *
 * The obvious approach does not work and it is worth writing down why, because it is the reason
 * everything below is shaped the way it is. `rancher/rancher` is the docker-style image with an
 * embedded k3s in it, and a pod running it fights the host cluster over cgroups: here a
 * privileged pod gets the node's own cgroup root rather than a namespace of its own, so its
 * kubelet is killed within seconds. That is what a previous pass investigated and concluded was
 * impossible, and it is not what this does.
 *
 * What this does instead is the topology Rancher actually supports. A manager pod helm-installs a
 * **vcluster** (a k3s control plane of its own, whose workloads are synced back to this cluster as
 * ordinary pods), then helm-installs cert-manager and rancher-latest *inside* that vcluster, which
 * is a completely ordinary Rancher installation on a completely ordinary cluster. The vcluster
 * replicates the rancher Service back out to this namespace, and the manager relays :443 to it, so
 * the sidecar's own Service points at the manager pod and everything downstream of it is unchanged.
 *
 * Every value here is the chart's rather than a fresh opinion: the vcluster version, the k8s
 * version kept below the rancher chart's ceiling, the hostPath data volume (this cluster has no
 * StorageClass, so a PVC would never bind), the watchdog, the order of the installs, their
 * timeouts, and the `role: relay` label that keeps the manager pod distinguishable from the
 * rancher pod the vcluster syncs into the same namespace with an `app: rancher` label of its own.
 *
 * The one thing added to the chart's script is the bootstrap, and there is a note on it below.
 */

/**
 * Where the vcluster's control plane keeps its data.
 *
 * Its own base rather than the workspace's, for two reasons: the workspace's directory is mounted
 * into the workspace container as `/workspace`, so a vcluster's etcd would appear inside somebody's
 * checkout, and a hostPath outlives the namespace that used it, so having one place to clean up is
 * worth more than having it next to the thing that made it.
 */
export const SIDECAR_HOST_PATH = '/var/lib/rancher/dev-sidecars';

/**
 * The vcluster's own values, from the chart.
 *
 * `volumeClaim.enabled: false` plus a hostPath dataVolume is how the chart handles a cluster with
 * no StorageClass, which is this one: a PVC would sit Pending for ever and the control plane would
 * never start.
 *
 * `replicateServices.toHost` is what makes the rest possible. The rancher Service inside the
 * vcluster is copied out into this namespace as `rancher-vc`, and that is what the relay dials.
 */
export const VCLUSTER_VALUES = `controlPlane:
  distro:
    k8s:
      enabled: true
      # Kept below the rancher chart's kubeVersion ceiling
      version: v1.34.1
  statefulSet:
    persistence:
      volumeClaim:
        enabled: false
      dataVolume:
        - name: data
          hostPath:
            path: {{dataPath}}
            type: DirectoryOrCreate
networking:
  replicateServices:
    toHost:
      - from: cattle-system/rancher
        to: rancher-vc
`;

/**
 * What the manager pod runs, start to finish. The chart's `manage.sh`, plus a bootstrap.
 *
 * The ordering and the waits are the chart's and are not rearranged. They exist because someone
 * hit the race they prevent:
 *
 *   - the watchdog goes first, before any install. A rollout's old pod runs the preStop pause at
 *     any moment, and it would otherwise scale the vcluster to nothing in the middle of this pod's
 *     install. It keeps the vcluster up for as long as this manager lives, so a real stop (which
 *     removes the manager) still pauses it.
 *   - `--wait` on the vcluster install, then a wait for the `vc-vc` Secret, then a wait for the
 *     API inside it to answer. The Secret carries the kubeconfig and appears after the install
 *     reports success; the API answers some time after that.
 *   - cert-manager before rancher, with its CRDs, because the rancher chart's issuer needs them.
 *
 * The kubeconfig rewrite is the chart's too: the config in the Secret points at localhost:8443,
 * which is right inside the control plane's pod and wrong everywhere else, and its CA is for a
 * name this pod does not dial.
 */
export const MANAGE_SCRIPT = `#!/bin/sh
set -x
apk add --no-cache socat curl || true

# Nothing is installed without a password to install it with.
#
# The reference to it is optional, so an absent or cleared key arrives as an empty variable rather
# than a failure to start. Rancher would then be installed with an empty bootstrapPassword, which
# makes it generate one of its own, and everything downstream would be trying to log in with a
# password that Rancher has never heard of. Refusing here is the difference between a sidecar that
# says what is wrong and a Rancher nobody can get into.
if [ -z "$CATTLE_BOOTSTRAP_PASSWORD" ]; then
  echo "refusing to install: RANCHER_BOOTSTRAP_PASSWORD is not set in the secret store"
  echo "set it in Settings, then start this sidecar again"
  exit 1
fi

# Watchdog (started first): a rollout's old pod runs the preStop pause and can race this pod's
# install at any phase. Keep the vcluster scaled up while this manager lives; a real stop removes
# the manager, so the pause sticks.
( while true; do kubectl -n "$NS" scale deploy vc --replicas=1 >/dev/null 2>&1 || true; sleep 30; done ) &

helm repo add loft https://charts.loft.sh
helm repo add jetstack https://charts.jetstack.io
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo update

helm upgrade --install vc loft/vcluster -n "$NS" \\
  --version "$VCLUSTER_VERSION" -f /scripts/vcluster-values.yaml \\
  --wait --timeout 10m

until kubectl -n "$NS" get secret vc-vc; do sleep 5; done
kubectl -n "$NS" get secret vc-vc -o jsonpath='{.data.config}' | base64 -d \\
  | sed -e "s|server: https://localhost:8443|server: https://vc.$NS.svc:443|" \\
        -e "s|certificate-authority-data:.*|insecure-skip-tls-verify: true|" > /tmp/kc
export KUBECONFIG=/tmp/kc
until kubectl get ns default; do sleep 5; done

helm upgrade --install cert-manager jetstack/cert-manager \\
  -n cert-manager --create-namespace \\
  --set crds.enabled=true --wait --timeout 10m

# The password goes in through a file rather than on the command line, and the file is written
# with tracing off. set -x is what makes this script readable while it runs, and it also prints
# every argument of every command, so the chart's --set bootstrapPassword=... puts the generated
# password into kubectl logs, readable by anything with pod/log in this namespace, and onto the
# sidecar card, which shows the last line while a sidecar is starting. The secretKeyRef keeps it
# out of the pod spec; this is the other half of the same promise.
set +x
printf 'bootstrapPassword: %s\\n' "$CATTLE_BOOTSTRAP_PASSWORD" > /tmp/rancher-values.yaml
chmod 600 /tmp/rancher-values.yaml
set -x

helm upgrade --install rancher rancher-latest/rancher \\
  -n cattle-system --create-namespace \\
  --set hostname="$RANCHER_HOSTNAME" --set replicas=1 \\
  -f /tmp/rancher-values.yaml \\
  --wait --timeout 20m

unset KUBECONFIG

# The relay, before the bootstrap rather than after it. The bootstrap talks to Rancher through
# this pod's own network either way, but starting the listener first is what lets the readiness
# probe pass and the card say Running while the bootstrap finishes, instead of holding the whole
# sidecar in Starting for the sake of three settings.
socat TCP-LISTEN:443,fork,reuseaddr "TCP:rancher-vc.$NS.svc:443" &

# ---- bootstrap: a Rancher you log into, not a setup wizard ----
#
# The steps are the closet api's (see magic-closet/CLAUDE.md): wait for the API, log in with the
# generated bootstrap password, turn off the first-login wizard, set the server URL and put the
# agent TLS mode on the system store. It runs here rather than anywhere else because this is the
# only place that already holds the password, by secretKeyRef, and never renders it; and because
# it is idempotent, so the manager restarting re-applies it exactly as the closet's "once per
# container" does.
RURL="https://rancher-vc.$NS.svc"

until curl -sk -o /dev/null --max-time 10 "$RURL/ping"; do sleep 5; done

# Tracing off for the rest of it. Every command from here carries either the password or the
# session token it returns, and neither belongs in a log.
set +x

# Writes the body to /tmp/login.json and prints the status, because the two failures need
# different answers and the body alone cannot tell them apart.
login() {
  curl -sk --max-time 20 -o /tmp/login.json -w '%{http_code}' \\
    -X POST "$RURL/v3-public/localProviders/local?action=login" \\
    -H 'content-type: application/json' \\
    -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$1\\"}"
}

token_from_login() {
  tr ',' '\\n' < /tmp/login.json | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' | head -1
}

TOKEN=""
i=0
while [ $i -lt 60 ]; do
  CODE=$(login "$CATTLE_BOOTSTRAP_PASSWORD")

  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    TOKEN=$(token_from_login)
    break
  fi

  # 401 is Rancher answering, and answering that this password is not its password. Waiting does
  # not change that, so the loop stops and the reset below runs. Retrying it to the end of the
  # count is how a rotated password turned into twenty-five minutes of a sidecar that looked fine
  # and was not: the retries are for a Rancher that is still starting, which is a refused
  # connection or a 5xx, not a considered no.
  if [ "$CODE" = "401" ]; then
    break
  fi

  sleep 5
  i=$((i + 1))
done

# The password in the store is only the password Rancher has if this Rancher was installed with
# it. The bootstrapPassword value applies at install and never again, so a Rancher that exists
# keeps whatever it was given the first time: rotate the key in the store and every login here
# fails, silently, and the value Settings shows is one nothing accepts.
#
# So when the login fails against a Rancher that is answering, the password is reset to the store's
# rather than left disagreeing with it. reset-password is Rancher's own recovery path and prints
# a working password; that is used once, to set ours, and never stored anywhere.
# Only on a considered 401, and only when there is a password to put back.
#
# reset-password changes the admin password to a fresh random string as a side effect of being
# run. If that string is then not set to anything, it exists in one shell variable in one
# container and nowhere else: not echoed, not written back, kept out of the trace by set +x. The
# version gated on an empty token reached that from three directions - a cleared key, a 200 with
# an unexpected body, and the loop simply running out - and each of them ended with a Rancher
# whose password nobody had.
if [ -z "$TOKEN" ] && [ "$CODE" = "401" ]; then
  echo "admin login failed; resetting the password to the one in the store"
  RESET=$(kubectl --kubeconfig /tmp/kc -n cattle-system exec deploy/rancher -- reset-password 2>/dev/null | tail -1 | tr -d '[:space:]')

  if [ -n "$RESET" ]; then
    login "$RESET" > /dev/null
    TEMP=$(token_from_login)
    USERID=$(curl -sk --max-time 20 -H "Authorization: Bearer $TEMP" "$RURL/v3/users?me=true" \\
      | tr ',' '\\n' | sed -n 's/.*"id":"\\(user-[^"]*\\)".*/\\1/p' | head -1)

    if [ -n "$TEMP" ] && [ -n "$USERID" ]; then
      # setpassword on the user, not changepassword. changepassword exists here only as a
      # collection action and answers 422 InvalidAction on a user id; setpassword is the one that
      # takes a user, and it also clears the mustChangePassword flag reset-password sets, which
      # would otherwise stop the next login at a change-your-password screen.
      SET=$(curl -sk --max-time 20 -X POST "$RURL/v3/users/$USERID?action=setpassword" \\
        -H "Authorization: Bearer $TEMP" -H 'content-type: application/json' \\
        -d "{\\"newPassword\\":\\"$CATTLE_BOOTSTRAP_PASSWORD\\"}" \\
        -o /dev/null -w '%{http_code}')
      echo "password reset $SET"

      # Read, not merely printed. A status that only ever went into curl's -w was a status nothing
      # acted on, so a rejected setpassword looked exactly like a successful one and the admin
      # password stayed at the value reset-password had just invented.
      case "$SET" in
        2*)
          CODE=$(login "$CATTLE_BOOTSTRAP_PASSWORD")

          if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
            TOKEN=$(token_from_login)
          fi
          ;;
        *)
          echo "SETTING THE ADMIN PASSWORD FAILED ($SET)."
          echo "This Rancher's admin password was changed by reset-password and is not the one in"
          echo "the secret store. To get back in, run reset-password again and use what it prints:"
          echo "  kubectl -n cattle-system exec deploy/rancher -- reset-password"
          ;;
      esac
    fi
  fi
fi

if [ -n "$TOKEN" ]; then
  for pair in "first-login=false" "server-url=$RURL" "agent-tls-mode=system-store"; do
    name=\${pair%%=*}
    value=\${pair#*=}
    curl -sk --max-time 20 -X PUT "$RURL/v3/settings/$name" \\
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
      -d "{\\"name\\":\\"$name\\",\\"value\\":\\"$value\\"}" \\
      -o /dev/null -w "bootstrap $name %{http_code}\\n"
  done
  echo "bootstrap done"
else
  echo "bootstrap skipped: could not log in as admin"
fi

wait
`;

/**
 * What a stop has to do, beyond scaling this pod to nothing.
 *
 * The vcluster is a StatefulSet and a Deployment of its own, installed by helm from inside this
 * pod, so nothing about scaling the manager touches them. Without this, Stop would leave a k3s
 * control plane and a whole Rancher running in the namespace with no card admitting to it.
 */
export const PAUSE_SCRIPT = `#!/bin/sh
kubectl -n "$NS" scale deploy vc --replicas=0 2>/dev/null
kubectl -n "$NS" scale sts vc --replicas=0 2>/dev/null
kubectl -n "$NS" delete pods -l vcluster.loft.sh/managed-by=vc --wait=false
`;

/**
 * The chart's vcluster chart version, and the rights its manager needs.
 *
 * The rules are the chart's `rancher-manager` Role verbatim: namespaced, but everything within the
 * namespace including RBAC, because a helm install of vcluster creates a ServiceAccount, a Role
 * and a RoleBinding of its own. Kubernetes' aggregated `edit` role, which is what an ordinary
 * workspace pod gets, deliberately excludes RBAC, so a manager running as that account fails
 * part-way through the install with a message about roles.
 */
export const VCLUSTER_VERSION = '0.36.0';

export const MANAGER_RULES = [{
  apiGroups: [
    '', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io',
    'policy', 'coordination.k8s.io', 'events.k8s.io', 'discovery.k8s.io',
  ],
  resources: ['*'],
  verbs:     ['*'],
}];
