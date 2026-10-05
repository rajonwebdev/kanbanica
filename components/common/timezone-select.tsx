"use client";

import { CaretUpDownIcon, CheckIcon, GlobeIcon } from "@phosphor-icons/react";
import * as React from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@/components/ui/combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatUtcOffset, listTimeZones } from "@/lib/timezone";
import { cn } from "@/lib/utils";

// Enough to cover a typed query; ~420 zones are available.
const MAX_RESULTS = 80;

/** Searchable IANA timezone picker ("Asia/Kolkata · UTC+05:30"). */
export function TimezoneSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  disabled?: boolean;
  id?: string;
  onChange: (timeZone: string) => void;
  value: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const zones = React.useMemo(() => {
    const all = listTimeZones();
    // Keep the current value selectable even if this runtime lists it under
    // another name.
    return all.includes(value) ? all : [value, ...all];
  }, [value]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    const matches = q
      ? zones.filter((z) => z.toLowerCase().includes(q))
      : zones;
    return matches.slice(0, MAX_RESULTS);
  }, [zones, query]);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          className="flex h-10 w-full items-center gap-2 rounded-md border border-base-300 bg-base-100 px-3 text-left text-sm transition-colors hover:bg-base-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          id={id}
          type="button"
        >
          <GlobeIcon className="size-4 shrink-0 text-base-content/60" />
          <span className="min-w-0 flex-1 truncate">{value}</span>
          <span className="shrink-0 text-xs text-base-content/60">
            {formatUtcOffset(value)}
          </span>
          <CaretUpDownIcon className="size-3.5 shrink-0 text-base-content/60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Combobox<string | null>
          immediate
          onChange={(zone) => {
            if (zone) {
              onChange(zone);
              setOpen(false);
              setQuery("");
            }
          }}
          value={value}
        >
          <ComboboxInput
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search timezones (e.g. Kolkata, New York)…"
            value={query}
          />
          <ComboboxOptions className="p-1" static>
            {results.length === 0 && (
              <ComboboxEmpty>No matching timezone.</ComboboxEmpty>
            )}
            {results.map((zone) => (
              <ComboboxOption key={zone} value={zone}>
                <CheckIcon
                  className={cn(
                    "size-3.5",
                    zone === value ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {zone.replace(/_/g, " ")}
                </span>
                <span className="shrink-0 text-xs text-base-content/60">
                  {formatUtcOffset(zone)}
                </span>
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        </Combobox>
      </PopoverContent>
    </Popover>
  );
}
