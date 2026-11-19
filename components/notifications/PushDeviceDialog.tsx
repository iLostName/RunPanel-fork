"use client";

import { useState } from "react";
import { Input, TextField } from "@heroui/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Field } from "@/components/ui/Field";
import { FormError } from "@/components/ui/FormError";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { NOTIFY_EVENTS, type NotifyEventKey, type NotifyFilter } from "@/lib/notify-events";
import { PUSH_DEVICE_NAME_MAX, type PublicPushDevice } from "@/lib/push-rules";
import { EventPicker } from "./EventPicker";

/**
 * One device's name and what it receives, like a channel's dialog: the name
 * the list shows, the events, "everything" or "only when something goes
 * wrong", and whether it receives anything at all.
 *
 * Saved to the panel this page is on, for the signed-in account only.
 */
export function PushDeviceDialog({
  isOpen,
  onOpenChange,
  device,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  device: PublicPushDevice;
  onSaved: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [events, setEvents] = useState<NotifyEventKey[]>(
    NOTIFY_EVENTS.filter((key) => device.events.includes(key))
  );
  const [filter, setFilter] = useState<NotifyFilter>(device.filter);
  const [enabled, setEnabled] = useState(device.enabled);
  const [serverError, setServerError] = useState<string | null>(null);

  const nameProblem = !name.trim()
    ? "Dai un nome al dispositivo"
    : name.trim().length > PUSH_DEVICE_NAME_MAX
      ? `Al massimo ${PUSH_DEVICE_NAME_MAX} caratteri`
      : null;

  async function submit(): Promise<boolean> {
    setServerError(null);
    try {
      const res = await fetch(`/api/account/push/devices/${encodeURIComponent(device.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), events, filter, enabled }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setServerError(body.error ?? MSG.saveFailed);
        return false;
      }
    } catch {
      setServerError(MSG.unreachable);
      return false;
    }
    toast.success("Dispositivo salvato");
    onSaved();
    return true;
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      wide
      title={`Modifica «${device.name}»`}
      submitLabel="Salva"
      isSubmitDisabled={Boolean(nameProblem)}
      onSubmit={submit}
    >
      <Field label="Nome" hint="Come lo riconosci nell'elenco: per esempio «iPhone di Marco» o «PC dell'ufficio»." error={nameProblem ?? undefined}>
        <TextField value={name} onChange={setName} aria-label="Nome" isInvalid={Boolean(nameProblem)}>
          <Input placeholder="Il mio telefono" autoComplete="off" />
        </TextField>
      </Field>

      <EventPicker events={events} onEventsChange={setEvents} filter={filter} onFilterChange={setFilter} />

      <SettingToggle
        label="Notifiche attive su questo dispositivo"
        description="Spento, non riceve niente; le notifiche restano comunque nella campanella."
        isSelected={enabled}
        onChange={setEnabled}
      />

      <FormError>{serverError}</FormError>
    </FormDialog>
  );
}
