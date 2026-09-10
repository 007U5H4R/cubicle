export type Role = "pm" | "researcher" | "designer" | "developer";

const ROLE_LABEL: Record<Role, string> = {
  pm: "PM",
  researcher: "Researcher",
  designer: "Designer",
  developer: "Developer",
};

/**
 * 16x16 geometric mark per role — deliberately not a face (Design.md §3.2):
 * PM = target/frame, Researcher = magnifier, Designer = pencil-nib, Developer = bracket {}.
 * Fill is currentColor so callers set the role text color on the wrapper.
 */
export function RoleGlyph({ role, className }: { role: Role; className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label={ROLE_LABEL[role]}
      className={className}
    >
      {role === "pm" && (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.4" />
        </>
      )}
      {role === "researcher" && (
        <>
          <circle cx="6.75" cy="6.75" r="4.25" stroke="currentColor" strokeWidth="1.4" />
          <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
      {role === "designer" && (
        <path
          d="M3 13.5L3.8 10.2L10.8 3.2C11.4 2.6 12.4 2.6 13 3.2C13.6 3.8 13.6 4.8 13 5.4L6 12.4L3 13.5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
      {role === "developer" && (
        <>
          <path
            d="M6.5 3C4.8 3 4 3.8 4 5.4V6.6C4 7.4 3.6 8 2.8 8C3.6 8 4 8.6 4 9.4V10.6C4 12.2 4.8 13 6.5 13"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 3C11.2 3 12 3.8 12 5.4V6.6C12 7.4 12.4 8 13.2 8C12.4 8 12 8.6 12 9.4V10.6C12 12.2 11.2 13 9.5 13"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
