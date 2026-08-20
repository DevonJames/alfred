/**
 * Capture (§11.1.1, §11.3).
 *
 * The acknowledgement here is load-bearing: "Remembered" appears only after the
 * desktop confirms the bytes and the raw input are durable. Anything less says
 * something weaker, on purpose.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Check, ImagePlus, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Card, ConfidenceTag, Display, Label, Notice } from "@/components/ui";
import { addMemory, addMemoryWithFiles, desktopErrorMessage, isNotBuiltYet } from "@/lib/desktop-api";
import { useMirror } from "@/lib/memory-cache";
import { useOutbox } from "@/lib/outbox";

interface Attachment {
  uri: string;
  name: string;
  mimeType: string;
}

export default function Capture() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);

  const save = useMutation({
    mutationFn: async () =>
      files.length > 0 ? addMemoryWithFiles(text.trim(), files) : addMemory(text.trim()),
    onSuccess: (result) => {
      // Confirmed by the Mac, so it's allowed into the phone's copy.
      useMirror.getState().put([result.memory]);
      queryClient.invalidateQueries({ queryKey: ["memory", "recent"] });
    },
  });

  const pick = useMutation({
    mutationFn: async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: 4,
      });
      if (result.canceled) return [];
      return result.assets.map((asset, index) => ({
        uri: asset.uri,
        name: asset.fileName ?? `photo-${index + 1}.jpg`,
        mimeType: asset.mimeType ?? "image/jpeg",
      }));
    },
    onSuccess: (picked) => setFiles((current) => [...current, ...picked]),
  });

  /**
   * Holding a capture on the phone is a fallback, never the happy path — so it
   * is offered only after a real attempt failed, and never described as
   * "remembered".
   */
  const hold = useMutation({
    mutationFn: () => useOutbox.getState().hold({ text: text.trim(), files }),
  });

  const saved = save.data?.memory;
  const held = hold.data;

  return (
    <Backdrop>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View className="flex-1 px-5" style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
          <View className="flex-row items-center justify-between">
            <Label>Remember this</Label>
            <Pressable
              testID="close-capture"
              onPress={() => router.back()}
              className="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
            >
              <X color="#8D939E" size={18} />
            </Pressable>
          </View>

          {held ? (
            <Animated.View entering={FadeIn} className="flex-1 justify-center" testID="capture-held">
              <Display className="text-center">Held on this phone.</Display>
              <Text className="mt-4 text-center text-sm leading-5 text-muted">
                I haven't remembered this yet — your Mac hasn't seen it. It's waiting here, and goes
                across the moment I can reach the desktop again.
              </Text>
              <Card className="mt-8">
                <Text className="text-base leading-6 text-bone">{held.text || "(photos only)"}</Text>
                {held.files.length > 0 ? (
                  <Text className="mt-2 text-xs text-faint">
                    {held.files.length} attachment{held.files.length === 1 ? "" : "s"}
                  </Text>
                ) : null}
              </Card>
              <Button
                testID="held-close"
                className="mt-10"
                label="Done"
                onPress={() => router.back()}
              />
            </Animated.View>
          ) : saved ? (
            <Animated.View entering={FadeIn} className="flex-1 justify-center" testID="capture-saved">
              <View className="items-center">
                <View className="h-14 w-14 items-center justify-center rounded-full bg-ok/15">
                  <Check color="#5AA97C" size={26} />
                </View>
                <Display className="mt-5 text-center">
                  {save.data?.durable ? "Remembered." : "Saved."}
                </Display>
                <Text className="mt-3 text-center text-sm leading-5 text-muted">
                  {saved.processingState === "indexed"
                    ? "Filed away and connected to what I already knew."
                    : saved.processingState === "needs_resolution"
                      ? "Kept safely — there's a detail I'd like you to clear up."
                      : "Kept safely on your Mac. I'll organise it shortly."}
                </Text>
              </View>

              <Card className="mt-8">
                <View className="flex-row items-start justify-between">
                  <Text className="flex-1 pr-3 text-base text-bone">{saved.title}</Text>
                  <ConfidenceTag value={saved.confidence} />
                </View>
                {save.data?.createdEntities.length ? (
                  <Text className="mt-3 text-xs text-faint">
                    New to me: {save.data.createdEntities.map((e) => e.title).join(", ")}
                  </Text>
                ) : null}
              </Card>

              <View className="mt-8 space-y-3">
                <Button
                  testID="view-saved-memory"
                  label="Look at it"
                  onPress={() => {
                    router.back();
                    router.push({ pathname: "/memory/[id]", params: { id: saved.id } });
                  }}
                />
                <Button
                  testID="capture-another"
                  variant="ghost"
                  label="Remember something else"
                  onPress={() => {
                    setText("");
                    setFiles([]);
                    save.reset();
                  }}
                />
              </View>
            </Animated.View>
          ) : (
            <ScrollView
              className="mt-4 flex-1"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <TextInput
                testID="capture-text-input"
                value={text}
                onChangeText={setText}
                autoFocus
                multiline
                placeholder="Tell me what happened, or what to keep in mind…"
                placeholderTextColor="#5F656F"
                className="min-h-[160px] rounded-2xl border border-line bg-ink-700 p-4 text-lg leading-7 text-bone"
                textAlignVertical="top"
              />

              {files.length > 0 ? (
                <View className="mt-4 space-y-2" testID="capture-attachments">
                  <Label>Attached</Label>
                  {files.map((file, index) => (
                    <Animated.View key={file.uri} entering={FadeInDown}>
                      <Card className="flex-row items-center justify-between py-3">
                        <Text numberOfLines={1} className="flex-1 pr-3 text-sm text-muted">
                          {file.name}
                        </Text>
                        <Pressable
                          testID={`remove-attachment-${index}`}
                          onPress={() => setFiles((c) => c.filter((f) => f.uri !== file.uri))}
                          className="active:opacity-60"
                        >
                          <X color="#5F656F" size={16} />
                        </Pressable>
                      </Card>
                    </Animated.View>
                  ))}
                </View>
              ) : null}

              <Pressable
                testID="add-attachment"
                onPress={() => pick.mutate()}
                className="mt-4 flex-row items-center space-x-2 self-start rounded-full border border-line bg-ink-700 px-4 py-2.5 active:opacity-70"
              >
                <ImagePlus color="#8D939E" size={16} />
                <Text className="text-sm text-muted">Add a photo</Text>
              </Pressable>

              {save.isError ? (
                <View className="mt-4 space-y-3">
                  <Notice testID="capture-error">
                    {desktopErrorMessage(
                      save.error,
                      "I couldn't reach your Mac, so I haven't claimed to remember this."
                    )}
                  </Notice>
                  {isNotBuiltYet(save.error) ? null : (
                    <Button
                      testID="hold-capture"
                      variant="ghost"
                      label="Keep it on this phone for now"
                      loading={hold.isPending}
                      onPress={() => hold.mutate()}
                    />
                  )}
                </View>
              ) : null}

              <Text className="mt-6 text-xs leading-5 text-faint">
                This goes straight to your Mac. Alfred reads it there, works out who and what it's
                about, and tells you if anything was unclear.
              </Text>
            </ScrollView>
          )}

          {!saved && !held ? (
            <Button
              testID="save-capture"
              className="mt-4"
              label="Remember this"
              disabled={!text.trim() && files.length === 0}
              loading={save.isPending}
              onPress={() => save.mutate()}
            />
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}
