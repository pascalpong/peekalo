import type { Metadata } from "next";
import { Profile } from "../../../components/profile";

export const metadata: Metadata = { title: "Mika's sample profile" };

export default function DemoProfilePage() {
  return <Profile />;
}
