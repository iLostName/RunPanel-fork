"use client";

import { memo } from "react";
import { useParams } from "next/navigation";
import type { LogLine } from "@/components/ui/LogViewer";
import { LogDeploySection } from "./LogDeploySection";
import { LogAppPanel } from "./LogAppPanel";

/**
 * Build output and the app's output.
 *
 * The build panel only appears while a deploy has lines on screen — that view
 * did not exist before: the build log could only be read from a deployment
 * that had already finished. Its title now follows the deploy to its end
 * (`LogDeploySection`).
 *
 * The app's output is the live buffer the page fills from the event stream,
 * with search, pause and clear on top of it, and the panel's own saved copy
 * behind "Storico" (`services/app-logs.ts`), which survives restarts and
 * deploys and is what "Scarica" downloads.
 *
 * Every prop after the first three is optional, so the page keeps working
 * before it passes them: `projectId` falls back to the route, the deploy state
 * to the log's own closing banner, the deployment to the newest one.
 */
export const LogsTab = memo(function LogsTab({
  deployLog,
  processLog,
  connected,
  projectId,
  deploying,
  deploymentId,
  runtimeType,
}: {
  deployLog: LogLine[];
  processLog: LogLine[];
  connected: boolean;
  projectId?: string;
  /** Whether a deploy is running now — `project.status === "deploying"`. */
  deploying?: boolean;
  /** The deploy whose lines `deployLog` holds, for downloading its whole log. */
  deploymentId?: string;
  /** Explains, for containers, that the live view cannot tell output from errors. */
  runtimeType?: string;
}) {
  const params = useParams<{ projectId?: string }>();
  const id = projectId ?? (typeof params?.projectId === "string" ? params.projectId : undefined);

  return (
    <div className="space-y-5">
      {deployLog.length > 0 && (
        <LogDeploySection lines={deployLog} deploying={deploying} projectId={id} deploymentId={deploymentId} />
      )}
      <LogAppPanel projectId={id} lines={processLog} connected={connected} runtimeType={runtimeType} />
    </div>
  );
});
