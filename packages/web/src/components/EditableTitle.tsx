import { useState, useEffect, useRef } from "react";

export function EditableTitle({
  title,
  onRename,
  placeholder,
  className = "text-2xl font-bold text-(--text-primary)",
  hint = "Click to rename",
}: {
  title: string;
  onRename: (title: string) => void;
  // Shown faintly when there is nothing yet, so an empty line is still something to click
  placeholder?: string;
  className?: string;
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function save() {
    const trimmed = value.trim();
    if (trimmed !== title && (trimmed || placeholder)) onRename(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={placeholder}
        className={`${className} bg-transparent border-b-2 border-blue-500 outline-none w-full`}
      />
    );
  }

  const Tag = placeholder ? "span" : "h1";
  return (
    <Tag
      onClick={() => { setValue(title); setEditing(true); }}
      className={`${title ? className : "text-(--text-faint)"} cursor-pointer hover:text-blue-700`}
      title={hint}
    >
      {title || placeholder}
    </Tag>
  );
}
