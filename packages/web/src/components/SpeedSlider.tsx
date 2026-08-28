type SpeedSliderProps = {
  value: number;
  onChange: (speed: number) => void;
  disabled?: boolean;
};

export function SpeedSlider({ value, onChange, disabled = false }: SpeedSliderProps) {
  return (
    <div className="w-48">
      <label className="block text-sm font-medium text-(--text-secondary) mb-1">
        Speed: {disabled ? "Fixed for this voice" : `${value.toFixed(1)}x`}
      </label>
      <input
        type="range"
        min="0.5"
        max="2.0"
        step="0.1"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="w-full accent-(--accent) disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}
