/**
 * Correct (§11.1.2). A correction is an *addition*: the desktop appends a new
 * assertion that supersedes the old one, and both stay readable forever. This
 * screen says that plainly so the user knows nothing is being erased.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Check, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Card, Display, Label, Loading, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { correctMemory, getEpisode } from "@/lib/desktop-api";
import { useMirror } from "@/lib/memory-cache";

export default function Correct() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string | null>(null);

  const memory = useQuery({
    queryKey: ["memory", id],
    queryFn: () => getEpisode(id),
    enabled: Boolean(id),
  });

  const submit = useMutation({
    mutationFn: () => correctMemory(id, text.trim(), target ?? undefined),
    onSuccess: (result) => {
      // The corrected reading replaces the old one in the phone's copy too,
      // history and all — otherwise an offline recall would quote what the user
      // has already put right.
      useMirror.getState().put([result.memory]);
      queryClient.invalidateQueries({ queryKey: ["memory", id] });
      queryClient.invalidateQueries({ queryKey: ["memory", "recent"] });
    },
  });

  const pkg = memory.data?.memory;
  const current = pkg?.assertions.filter((a) => a.current) ?? [];
  const done = submit.data;

  return (
    <Backdrop>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View className="flex-1 px-5" style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
          <View className="flex-row items-center justify-between">
            <Label>Put me right</Label>
            <Pressable
              testID="close-correct"
              onPress={() => router.back()}
              className="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
            >
              <X color="#8D939E" size={18} />
            </Pressable>
          </View>

          {done ? (
            <Animated.View entering={FadeIn} className="flex-1 justify-center" testID="correct-done">
              <View className="items-center">
                <View className="h-14 w-14 items-center justify-center rounded-full bg-ok/15">
                  <Check color="#5AA97C" size={26} />
                </View>
                <Display className="mt-5 text-center">Noted.</Display>
                <Text className="mt-3 text-center text-sm leading-5 text-muted">
                  I've added your correction as revision {done.revision}.
                  {done.supersededAssertionId
                    ? " The earlier version is still on record — I just don't lead with it any more."
                    : ""}
                </Text>
              </View>
              <Button
                testID="correct-close"
                className="mt-10"
                label="Done"
                onPress={() => router.back()}
              />
            </Animated.View>
          ) : (
            <>
              <ScrollView
                className="mt-4 flex-1"
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {memory.isLoading ? <Loading /> : null}

                {pkg ? (
                  <>
                    <Display className="text-3xl">{pkg.title}</Display>

                    {current.length > 0 ? (
                      <View className="mt-6 space-y-2">
                        <Label>Which part is wrong?</Label>
                        <Text className="text-xs leading-4 text-faint">
                          Optional — if you skip this, I'll work out which claim you mean.
                        </Text>
                        {current.map((assertion) => (
                          <Pressable
                            key={assertion.id}
                            testID={`target-${assertion.id}`}
                            onPress={() =>
                              setTarget(target === assertion.id ? null : assertion.id)
                            }
                            className="active:opacity-70"
                          >
                            <Card
                              className={cn(
                                "py-3",
                                target === assertion.id && "border-brass bg-brass/10"
                              )}
                            >
                              <Text
                                className={cn(
                                  "text-sm leading-5",
                                  target === assertion.id ? "text-brass" : "text-muted"
                                )}
                              >
                                {assertion.text}
                              </Text>
                            </Card>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}

                    <View className="mt-6">
                      <Label>What's actually true?</Label>
                      <TextInput
                        testID="correction-input"
                        value={text}
                        onChangeText={setText}
                        autoFocus
                        multiline
                        placeholder="It was Thursday, not Tuesday…"
                        placeholderTextColor="#5F656F"
                        className="mt-2 min-h-[120px] rounded-2xl border border-line bg-ink-700 p-4 text-base leading-6 text-bone"
                        textAlignVertical="top"
                      />
                    </View>

                    {submit.isError ? (
                      <View className="mt-4">
                        <Notice testID="correct-error">
                          I couldn't save that correction. Nothing has changed.
                        </Notice>
                      </View>
                    ) : null}

                    <Text className="mt-6 text-xs leading-5 text-faint">
                      I don't overwrite what you told me before. Your correction is added on top,
                      and the old version stays visible in the history.
                    </Text>
                  </>
                ) : null}
              </ScrollView>

              <Button
                testID="submit-correction"
                className="mt-4"
                label="Save the correction"
                disabled={!text.trim()}
                loading={submit.isPending}
                onPress={() => submit.mutate()}
              />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}
