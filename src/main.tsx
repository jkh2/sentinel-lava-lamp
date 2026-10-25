import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LampExperience } from "@/components/lamp/experience";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <LampExperience />
    </StrictMode>,
  );
}
