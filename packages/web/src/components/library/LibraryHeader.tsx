import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../Button.tsx";
import { ProfileSwitcher } from "../ProfileSwitcher.tsx";
import { SettingsModal } from "../SettingsModal.tsx";
import { AssistantToggle } from "../assistant/AssistantPanel.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { IconPhone, IconSettings } from "../icons.tsx";

// The app bar, the same row on every page — the library, the Phone page and a book — so moving
// between them moves nothing: the name (a way back to the library from anywhere else), the profile,
// the phone, then the assistant, the appearance and the settings. What a page does with itself
// lives in its own row underneath.
export function LibraryHeader({ page }: { page: "library" | "phone" | "book" }) {
  const [showSettings, setShowSettings] = useState(false);
  const name = "Libratory";
  return (
    <div className="flex items-center gap-2 h-12 px-4 border-b border-(--border) bg-(--bg-card)">
      <h1 className="font-(family-name:--stack-display) text-[17px] font-semibold tracking-tight text-(--text-primary)">
        {page === "library" ? name : (
          <Link to="/" title="Back to the library" className="hover:opacity-75" data-testid="app-home-link">
            {name}
          </Link>
        )}
      </h1>
      <ProfileSwitcher />
      {/* Lit on its own page, the way the design shows it, rather than disabled and greyed */}
      <Button
        variant={page === "phone" ? "primary" : "secondary"}
        size="sm"
        to="/phone"
        title="Add this profile's shelf to a phone, and see what the paired phones can reach"
        data-testid="phone-page-link"
      >
        <IconPhone className="h-4 w-4" />
        Phone
      </Button>
      <div className="flex-1" />
      <AssistantToggle />
      <ThemeToggle />
      <Button
        variant="icon"
        size="sm"
        onClick={() => setShowSettings(true)}
        title="AI model settings"
        aria-label="AI model settings"
        data-testid="settings-gear"
      >
        <IconSettings className="h-4 w-4" />
      </Button>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
