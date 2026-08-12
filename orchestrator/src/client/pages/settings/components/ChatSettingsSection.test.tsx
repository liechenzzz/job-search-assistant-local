import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Accordion } from "@/components/ui/accordion";
import { ChatSettingsSection } from "./ChatSettingsSection";

vi.mock("@/components/ui/select", () => {
  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void;
  } | null>(null);

  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => {
    return (
      <SelectContext.Provider value={{ onValueChange }}>
        <div>
          <input readOnly value={value ?? ""} aria-label="select-value" />
          {children}
        </div>
      </SelectContext.Provider>
    );
  };

  const SelectContent = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );
  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const context = React.useContext(SelectContext);

    return (
      <button type="button" onClick={() => context?.onValueChange?.(value)}>
        {children}
      </button>
    );
  };
  const SelectTrigger = ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" role="combobox" aria-expanded="false" {...props}>
      {children}
    </button>
  );
  const SelectValue = () => null;

  return {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
  };
});

const ChatSettingsHarness = ({
  mode = "onSubmit" as const,
}: {
  mode?: "onSubmit" | "onChange";
} = {}) => {
  const methods = useForm<UpdateSettingsInput>({
    mode,
    defaultValues: {
      chatStyleTone: "",
      chatStyleFormality: "",
      chatStyleConstraints: "",
      chatStyleDoNotUse: "",
      chatStyleLanguageMode: null,
      chatStyleManualLanguage: null,
      ghostwriterStopSlopEnabled: null,
      chatStyleSummaryMaxWords: null,
      chatStyleMaxKeywordsPerSkill: null,
      humanizerEnabled: null,
      impactFramingEnabled: null,
      roleFramingMode: null,
      manualRoleFamily: null,
      customRoleFramingInstructions: "",
    },
  });

  return (
    <FormProvider {...methods}>
      <Accordion type="multiple" defaultValue={["chat"]}>
        <ChatSettingsSection
          values={{
            tone: { effective: "professional", default: "professional" },
            formality: { effective: "medium", default: "medium" },
            constraints: { effective: "", default: "" },
            doNotUse: { effective: "", default: "" },
            languageMode: { effective: "manual", default: "manual" },
            manualLanguage: { effective: "english", default: "english" },
            stopSlopEnabled: { effective: false, default: false },
            summaryMaxWords: { effective: null, default: null },
            maxKeywordsPerSkill: { effective: null, default: null },
            humanizerEnabled: { effective: true, default: true },
            impactFramingEnabled: { effective: true, default: true },
            roleFramingMode: { effective: "auto", default: "auto" },
            manualRoleFamily: {
              effective: "public_sector_policy_economic_development",
              default: "public_sector_policy_economic_development",
            },
            customRoleFramingInstructions: { effective: "", default: "" },
          }}
          isLoading={false}
          isSaving={false}
        />
      </Accordion>
    </FormProvider>
  );
};

describe("ChatSettingsSection", () => {
  it("treats blank overrides as unset so preset and selects stay aligned", () => {
    render(<ChatSettingsHarness />);

    expect(screen.getAllByDisplayValue("professional").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByDisplayValue("medium")).toBeInTheDocument();
    expect(screen.getByDisplayValue("manual")).toBeInTheDocument();
    expect(screen.getByDisplayValue("english")).toBeInTheDocument();
  });

  it("applies preset values to the writing style fields", () => {
    render(<ChatSettingsHarness />);

    fireEvent.click(screen.getAllByRole("button", { name: "Friendly" })[0]);

    expect(screen.getAllByDisplayValue("friendly").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("low")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "Keep the response warm, approachable, and confident.",
      ),
    ).toBeInTheDocument();
  });

  it("hides the manual language selector when matching the resume language", () => {
    render(<ChatSettingsHarness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Match current resume language" }),
    );

    expect(
      screen.queryByRole("combobox", { name: /specific language/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("english")).not.toBeInTheDocument();
  });

  it("renders the Stop Slop Ghostwriter toggle", () => {
    render(<ChatSettingsHarness />);

    expect(
      screen.getByLabelText("Use Stop Slop for Ghostwriter"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Effective: Disabled/)).toBeInTheDocument();
  });

  it("renders application writing strategy controls", () => {
    render(<ChatSettingsHarness />);

    expect(screen.getByLabelText("Use Humanizer")).toBeInTheDocument();
    expect(screen.getByLabelText("Use impact framing")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Role framing" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("auto")).toBeInTheDocument();
  });

  it("shows role family and custom instructions when manual custom role is selected", () => {
    render(<ChatSettingsHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose role family" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));

    expect(
      screen.getByRole("combobox", { name: "Role family" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Custom role instructions"),
    ).toBeInTheDocument();
  });

  it("shows validation error when summary word limit is out of range", async () => {
    const { container } = render(<ChatSettingsHarness mode="onChange" />);

    const input = container.querySelector(
      "#chatStyleSummaryMaxWords",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999", valueAsNumber: 999 } });

    await waitFor(() => {
      expect(screen.getByText("Must be between 1 and 500")).toBeInTheDocument();
    });
  });

  it("shows validation error when max keywords per skill is out of range", async () => {
    const { container } = render(<ChatSettingsHarness mode="onChange" />);

    const input = container.querySelector(
      "#chatStyleMaxKeywordsPerSkill",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0", valueAsNumber: 0 } });

    await waitFor(() => {
      expect(screen.getByText("Must be between 1 and 50")).toBeInTheDocument();
    });
  });

  it("does not show validation error for valid summary word limit", async () => {
    const { container } = render(<ChatSettingsHarness mode="onChange" />);

    const input = container.querySelector(
      "#chatStyleSummaryMaxWords",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50", valueAsNumber: 50 } });

    await waitFor(() => {
      expect(
        screen.queryByText("Must be between 1 and 500"),
      ).not.toBeInTheDocument();
    });
  });
});
