"use client";

import { Input, TextField } from "@heroui/react";
import { Field } from "@/components/ui/Field";
import { SettingToggle } from "@/components/ui/SettingToggle";
import type { CatalogQuestion } from "@/lib/app-catalog";

/** One question of a template, drawn the way its type asks. */
export function QuestionField({
  question,
  value,
  onChange,
  error,
}: {
  question: CatalogQuestion;
  /** As the variable will hold it: a boolean is its `on`/`off` value. */
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  if (question.type === "boolean") {
    const { on, off } = question.values ?? { on: "true", off: "false" };
    return (
      <div>
        <SettingToggle
          label={question.label}
          description={question.help}
          isSelected={value === on}
          onChange={(next) => onChange(next ? on : off)}
        />
        {error && (
          <p className="text-danger text-meta mt-1" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Field label={question.label} hint={question.help} error={error}>
      <TextField value={value} onChange={onChange} aria-label={question.label}>
        <Input
          type={question.type === "password" ? "password" : question.type === "email" ? "email" : "text"}
          inputMode={question.type === "number" ? "numeric" : undefined}
          placeholder={question.placeholder}
          className={question.type === "number" ? "max-w-[10rem] font-mono text-sm" : undefined}
        />
      </TextField>
    </Field>
  );
}
