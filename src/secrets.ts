import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const REQUIRED_SECRET_KEYS = [
  "SHARK_API_KEY",
  "SHARK_API_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
  "TELEGRAM_ALLOWED_CHAT_ID",
  "DATABASE_URL",
] as const;

const ALLOWED_SECRET_KEYS = new Set<string>(REQUIRED_SECRET_KEYS);

export async function loadRuntimeEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const secretId = base.AWS_SECRETS_MANAGER_SECRET_ID?.trim();
  const isProduction = base.NODE_ENV === "production";
  if (!secretId) {
    if (isProduction) {
      throw new Error(
        "AWS_SECRETS_MANAGER_SECRET_ID is required in production",
      );
    }
    return { ...base };
  }
  const region = base.AWS_REGION?.trim();
  if (!region)
    throw new Error("AWS_REGION is required to load runtime secrets");

  const client = new SecretsManagerClient({ region });
  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    if (!response.SecretString)
      throw new Error("Secrets Manager value must be a JSON SecretString");
    const parsed = JSON.parse(response.SecretString) as unknown;
    return mergeRuntimeSecret(base, parsed);
  } finally {
    client.destroy();
  }
}

export function mergeRuntimeSecret(
  base: NodeJS.ProcessEnv,
  secret: unknown,
): NodeJS.ProcessEnv {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
    throw new Error("Secrets Manager value must be a JSON object");
  }
  const record = secret as Record<string, unknown>;
  const environment = Object.fromEntries(
    Object.entries(base).filter(([key]) => !ALLOWED_SECRET_KEYS.has(key)),
  );
  for (const key of REQUIRED_SECRET_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `Secrets Manager field ${key} must be a non-empty string`,
      );
    }
    environment[key] = value;
  }
  return environment;
}
