import net from "net";
import { stackLeftovers, type CatalogTemplate, type DockerInventory } from "@/lib/app-catalog";
import { dockerTry, isDockerAvailable, lines } from "../docker/cli";
import { composeProjectName } from "../docker/compose";

/**
 * What the machine has to say before an install writes anything.
 *
 * Each of these is a way an install could look done and not work: no Docker,
 * so the first deploy fails a minute later; a port something outside the panel
 * already holds; or — the one that does damage — the volumes of an earlier
 * install under the same name. Deleting a Compose project keeps its named
 * volumes (they are the data), and Compose would hand them to the new stack
 * without a word: a fresh WordPress on the old database, whose password is the
 * old one, and a site that cannot connect. So their presence stops the install,
 * and nothing is ever removed from here.
 */

export async function dockerProblem(): Promise<string | null> {
  if (!(await isDockerAvailable())) {
    return "Docker non risponde su questo server: le app del catalogo girano in container. Avvialo e riprova.";
  }
  if (!(await dockerTry(["compose", "version", "--short"], { timeout: 15_000 }))) {
    return "Su questo server manca Docker Compose (il comando «docker compose»): installalo e riprova.";
  }
  return null;
}

/** Null when Docker could not be asked, which the caller treats as a refusal: not knowing is not "nothing there". */
export async function dockerInventory(): Promise<DockerInventory | null> {
  const label = '{{.Label "com.docker.compose.project"}}';
  const [volumes, containers] = await Promise.all([
    dockerTry(["volume", "ls", "--format", `{{.Name}}\t${label}`], { timeout: 30_000 }),
    dockerTry(["ps", "-a", "--format", `{{.Names}}\t${label}`], { timeout: 30_000 }),
  ]);
  if (!volumes || !containers) return null;

  const split = (line: string) => {
    const [name, project] = line.split("\t");
    return { name: name ?? "", project: project ?? "" };
  };
  return {
    volumes: lines(volumes.stdout).map(split),
    // One container can answer to several names, comma-separated.
    containers: lines(containers.stdout).flatMap((line) => {
      const { name, project } = split(line);
      return name.split(",").map((n) => ({ name: n.trim(), project })).filter((c) => c.name);
    }),
  };
}

/** What an install under `slug` would collide with: see `stackLeftovers`. */
export function leftoversIn(inventory: DockerInventory, slug: string, template: CatalogTemplate): string[] {
  return stackLeftovers(inventory, composeProjectName(slug), template);
}

/**
 * Whether nothing on this machine is listening on `port`.
 *
 * Asked of the kernel by trying to listen, which is the only party that knows:
 * a port published by a container outside the panel, or held by a system
 * service, appears in no table the panel keeps.
 */
export function portFreeOnHost(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => probe.close(() => resolve(true)));
  });
}
