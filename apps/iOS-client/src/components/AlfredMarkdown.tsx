/**
 * Alfred reply markdown — bone display type, no chrome.
 */
import { useMemo } from "react";
import { StyleSheet, Text, type TextStyle } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import { closeIncompleteMarkdown } from "@/lib/markdown";

const BODY: TextStyle = {
  fontFamily: "InstrumentSerif_400Regular",
  fontSize: 20,
  lineHeight: 30,
  color: "#F4F1EA",
};

const BODY_LARGE: TextStyle = {
  ...BODY,
  fontSize: 24,
  lineHeight: 32,
};

const FAINT: TextStyle = {
  ...BODY,
  color: "#8D939E",
};

type Props = {
  children: string;
  /** Larger serif used in chat-stage assistant bubbles. */
  large?: boolean;
  muted?: boolean;
  /** Close trailing `**` / `` ` `` so mid-utterance reveal renders cleanly. */
  incomplete?: boolean;
};

export function AlfredMarkdown({ children, large, muted, incomplete = true }: Props) {
  const source = incomplete ? closeIncompleteMarkdown(children) : children;
  const base = muted ? FAINT : large ? BODY_LARGE : BODY;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: base,
        paragraph: { ...base, marginTop: 0, marginBottom: 8 },
        strong: { ...base, fontWeight: "700" as const },
        em: { ...base, fontStyle: "italic" as const },
        heading1: { ...base, fontSize: (base.fontSize ?? 20) + 4, marginBottom: 6 },
        heading2: { ...base, fontSize: (base.fontSize ?? 20) + 2, marginBottom: 6 },
        heading3: { ...base, fontWeight: "700" as const, marginBottom: 4 },
        heading4: { ...base, fontWeight: "700" as const, marginBottom: 4 },
        heading5: { ...base, fontWeight: "700" as const },
        heading6: { ...base, fontWeight: "700" as const },
        bullet_list: { marginBottom: 6 },
        ordered_list: { marginBottom: 6 },
        list_item: { ...base, marginBottom: 2 },
        bullet_list_icon: { ...base, color: "#D8A54A", marginLeft: 0 },
        ordered_list_icon: { ...base, color: "#D8A54A" },
        code_inline: {
          ...base,
          fontFamily: undefined,
          fontSize: (base.fontSize ?? 20) - 2,
          backgroundColor: "#1A1C20",
          color: "#D8A54A",
        },
        fence: {
          ...base,
          fontFamily: undefined,
          fontSize: (base.fontSize ?? 20) - 2,
          backgroundColor: "#1A1C20",
          padding: 10,
          marginVertical: 8,
        },
        link: { ...base, color: "#D8A54A", textDecorationLine: "underline" as const },
        blockquote: {
          ...base,
          borderLeftColor: "#D8A54A",
          borderLeftWidth: 2,
          paddingLeft: 10,
          color: "#8D939E",
        },
        hr: { backgroundColor: "#2A2E36", height: 1, marginVertical: 10 },
      }),
    [base]
  );

  const rules: RenderRules = useMemo(
    () => ({
      // Avoid default View wrappers adding extra vertical chrome in a caption line.
      paragraph: (node, children, _parent, styles) => (
        <Text key={node.key} style={styles.paragraph}>
          {children}
        </Text>
      ),
    }),
    []
  );

  if (!source.trim()) return null;

  return (
    <Markdown style={styles} rules={rules}>
      {source}
    </Markdown>
  );
}
