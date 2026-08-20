/**
 * The alfrd.net account screen — deliberately off the main path.
 *
 * Linking a Mac normally needs no account at all: the phone makes one for
 * itself the first time it claims (cloud-identity.ts). This screen exists for
 * the two cases where that isn't enough — a Mac already linked to an account
 * (`409` on claim), and a second phone that should join the first one's
 * account rather than fight it for the claim.
 */
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Display, Field, Label, Notice } from "@/components/ui";
import { ApiError, login, register } from "@/lib/cloud-api";
import { markUserAccount } from "@/lib/cloud-identity";
import { useConnection } from "@/lib/connection";

export default function CloudAccount() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const insets = useSafeAreaInsets();
  const serverId = useConnection((s) => s.serverId);

  const submit = useMutation({
    mutationFn: async () => {
      const result =
        mode === "login" ? await login(email, password) : await register(email, password, name);
      await markUserAccount(result.token, result.user.email);
      return result;
    },
    onSuccess: () =>
      router.replace(serverId ? "/(onboarding)/discovering" : "/(onboarding)/claim"),
  });

  const canSubmit =
    email.includes("@") && password.length >= 8 && (mode === "login" || name.trim().length > 0);

  return (
    <Backdrop>
      <KeyboardAwareScrollView
        testID="cloud-login-screen"
        contentContainerStyle={{
          paddingTop: insets.top + 72,
          paddingBottom: 48,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <Animated.View entering={FadeInDown.duration(400)}>
          <Label>Optional</Label>
          <Display className="mt-3">Use an alfrd.net account.</Display>
          <Text className="mt-4 text-base leading-[22px] text-muted">
            You don't need one to use Alfred. Sign in only if your Mac is already linked to an
            account — on another phone, or before you reinstalled. Your memory stays on the Mac
            either way.
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(120).duration(400)} className="mt-10 space-y-4">
          {mode === "register" ? (
            <Field
              testID="display-name-input"
              label="What should Alfred call you?"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoComplete="name"
              placeholder="Devon"
            />
          ) : null}
          <Field
            testID="email-input"
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="you@example.com"
          />
          <Field
            testID="password-input"
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="At least 8 characters"
          />

          {submit.isError ? (
            <Notice testID="login-error">
              {submit.error instanceof ApiError
                ? submit.error.message
                : "Something went wrong. Try again."}
            </Notice>
          ) : null}

          <Button
            testID="login-submit"
            label={mode === "login" ? "Sign in" : "Create account"}
            disabled={!canSubmit}
            loading={submit.isPending}
            onPress={() => submit.mutate()}
          />

          <Pressable
            testID="toggle-auth-mode"
            onPress={() => {
              submit.reset();
              setMode(mode === "login" ? "register" : "login");
            }}
            className="items-center py-3 active:opacity-60"
          >
            <Text className="text-sm text-brass">
              {mode === "login" ? "I don't have an account yet" : "I already have an account"}
            </Text>
          </Pressable>

          <Pressable
            testID="back-to-claim"
            onPress={() => router.replace("/(onboarding)/claim")}
            className="items-center py-3 active:opacity-60"
          >
            <Text className="text-sm text-faint">Go back to scanning the code</Text>
          </Pressable>
        </Animated.View>

        <View className="mt-12">
          <Text className="text-xs leading-5 text-faint">
            Alfred keeps your notes, people and moments on the machine you own. This app is the
            microphone and the window — not the vault.
          </Text>
        </View>
      </KeyboardAwareScrollView>
    </Backdrop>
  );
}
