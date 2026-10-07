import { useSearchParams } from "react-router-dom";
import { useSession } from "../session";

/*
 * Starting-point legal pages. TikTok requires a public terms of service and privacy policy before it
 * approves an app for the Content Posting API. Have a lawyer review these before launch.
 */

export function Terms() {
  const { config } = useSession();
  const app = config?.appName ?? "This site";
  return (
    <article className="page narrow prose">
      <h1>Terms of use</h1>
      <p>
        {app} is a tool for creating tokens on pump.fun and running AI characters that post on TikTok. By using it you agree to
        these terms.
      </p>
      <h2>Tokens</h2>
      <p>
        Tokens are created on the Solana blockchain through pump.fun, from your wallet, and are your responsibility. {app} does not
        sell, promote, or endorse any token, and nothing on this site or posted by any AI character is financial advice. Tokens
        can lose all their value.
      </p>
      <h2>AI characters and TikTok</h2>
      <p>
        You must own or control any TikTok account you connect, and you are responsible for its content and for following
        TikTok's terms of service and community guidelines. AI characters are labelled as AI, and posts carry TikTok's
        AI-generated content label. You must not use a character to impersonate
        a real person or brand, or to make claims about returns or prices.
      </p>
      <h2>Treasury</h2>
      <p>
        Each coin has an agent wallet controlled by the platform's software. The coin's creator fees are paid into it, and it
        automatically uses them to buy back and burn the coin, within platform limits. The treasury cannot be withdrawn by you
        or turned off by you. Software and blockchains fail; you
        accept the risk of loss.
      </p>
      <h2>Fees</h2>
      <p>A platform fee is charged at launch and shown before you sign.</p>
      <h2>Changes and termination</h2>
      <p>We may pause or stop any coin's posting or treasury activity to comply with law or platform rules, or to prevent harm.</p>
    </article>
  );
}

export function Privacy() {
  const { config } = useSession();
  const app = config?.appName ?? "This site";
  return (
    <article className="page narrow prose">
      <h1>Privacy policy</h1>
      <h2>What we collect</h2>
      <ul>
        <li>Your public wallet address, used to sign you in and link you to the coins you create.</li>
        <li>The coin details and character settings you enter.</li>
        <li>
          For TikTok accounts you connect: the account's open ID, username, display name, profile picture, and access and refresh
          tokens that let the AI character publish posts. Tokens are encrypted at rest.
        </li>
        <li>Server logs (IP address, request times) kept for security for up to 30 days.</li>
      </ul>
      <h2>How we use it</h2>
      <p>
        Only to run the service: launching coins, generating posts with AI providers, and publishing them to the TikTok account
        you connected. We don't sell personal data.
      </p>
      <h2>Service providers</h2>
      <p>
        Content is generated with third-party AI providers, and media is stored with our hosting and storage providers. Token
        metadata is published to IPFS and the Solana blockchain, which are public and permanent.
      </p>
      <h2>Your choices</h2>
      <p>
        You can disconnect TikTok from your coin's settings at any time, or remove {app} in TikTok under Settings and privacy,
        then Security and permissions, then Apps and services permissions. See <a href="/data-deletion">data deletion</a> to have your data removed.
      </p>
    </article>
  );
}

export function DataDeletion() {
  const [params] = useSearchParams();
  const code = params.get("code");
  return (
    <article className="page narrow prose">
      <h1>Data deletion</h1>
      {code && (
        <p className="notice notice-ok">
          Your deletion request was received. Confirmation code: <code>{code}</code>
        </p>
      )}
      <p>To delete the TikTok data we hold for an account you connected:</p>
      <ol>
        <li>Open TikTok, go to Settings and privacy, then Security and permissions, then Apps and services permissions.</li>
        <li>Remove this app. TikTok tells us and we delete the stored access tokens automatically.</li>
      </ol>
      <p>
        You can also disconnect TikTok from your coin's settings page. Coin data written to the blockchain and IPFS is public
        and can't be deleted by anyone.
      </p>
    </article>
  );
}
