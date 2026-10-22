type IconName = "arrow" | "eye" | "lock" | "spark" | "clock" | "link";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "arrow" && <><path d="M5 12h14M13 6l6 6-6 6" /></>}
      {name === "eye" && <><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></>}
      {name === "lock" && <><rect x="5.5" y="10" width="13" height="10" rx="3" /><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3M12 14v2" /></>}
      {name === "spark" && <><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z" /></>}
      {name === "clock" && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>}
      {name === "link" && <><path d="m9 15 6-6M8.5 10.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M10.5 8.5l2-2a3.5 3.5 0 0 1 5 5l-2 2" /></>}
    </svg>
  );
}

export { BrandMark } from './brand-logo';
