import { useState } from "react";
import { KeyRound } from "lucide-react";

export default function AdminTokenCard({
  token,
  onSaveToken,
}: {
  token: string;
  onSaveToken: (token: string) => void;
}) {
  const [draft, setDraft] = useState(token);
  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#94A3B8]">
          Admin API Token
        </h3>
        <KeyRound className="h-4 w-4 text-[#1A1A1A]" />
      </div>
      <p className="text-xs text-[#64748B] mb-3">
        Required for Sync, Manual Trade, Emergency Close, and saving settings. Stored only in this
        browser (localStorage), never sent to any third party.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Paste ADMIN_API_TOKEN"
          className="flex-1 text-xs font-mono border border-[#E2E8F0] rounded px-3 py-2 bg-[#F8F9FA]"
        />
        <button
          onClick={() => onSaveToken(draft.trim())}
          className="text-[11px] font-bold uppercase tracking-wider bg-[#1A1A1A] text-white rounded px-4 py-2 cursor-pointer"
        >
          Save
        </button>
      </div>
      <div className="mt-3 text-[10px] font-mono text-[#94A3B8] uppercase tracking-wider">
        Status: {token ? "Token configured" : "Not configured — admin actions will fail"}
      </div>
    </div>
  );
}
