import { createFileRoute } from "@tanstack/react-router";
import { LampExperience } from "@/components/lamp/experience";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <LampExperience />;
}
