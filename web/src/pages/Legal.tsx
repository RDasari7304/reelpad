import { useSearchParams } from "react-router-dom";
import { useSession } from "../session";

/*
 * Starting-point legal pages. Meta requires a public privacy policy and data-deletion instructions
 * before it approves an app for Instagram publishing. Have a lawyer review these before launch.
 */

export function Terms() {
  const { config } = useSession();
  const app = config?.appName ?? "This site";
  return (
    <article className="page narrow prose">
      <h1>Terms of use</h1>
      <p>
        {app} is a tool for creating tokens on pump.fun and running AI characters that post on Instagram. By using it you agree to
        these terms.
      </p>
      <h2>Tokens</h2>
      <p>
        Tokens are created on the Solana blockchain through pump.fun, from your wallet, and are your responsibility. {app} does not
        sell, promote, or endorse any token, and nothing on this site or posted by any AI character is financial advice. Tokens
        can lose all their value.
      </p>
      <h2>AI characters and Instagram</h2>
      <p>
        You must own or control any Instagram account you connect, and you are responsible for its content and for following
        Instagram's terms and community guidelines. AI characters are labelled as AI. You must not use a character to impersonate
        a real person or brand, or to make claims about returns or prices.
      </p>
      <h2>Treasury</h2>
      <p>
        Each coin has an agent wallet controlled by the platform's software. Creator fees are paid into it, and it may buy or
        burn the coin within the limits you set. The treasury cannot be withdrawn by you. Software and blockchains fail; you
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
          For Instagram accounts you connect: the account ID, username, profile picture and an access token that lets the AI
          character publish posts. Tokens are encrypted at rest.
        </li>
        <li>Server logs (IP address, request times) kept for security for up to 30 days.</li>
      </ul>
      <h2>How we use it</h2>
      <p>
        Only to run the service: launching coins, generating posts with AI providers, and publishing them to the Instagram account
        you connected. We don't sell personal data.
      </p>
      <h2>Service providers</h2>
      <p>
        Content is generated with third-party AI providers, and media is stored with our hosting and storage providers. Token
        metadata is published to IPFS and the Solana blockchain, which are public and permanent.
      </p>
      <h2>Your choices</h2>
      <p>
        You can disconnect Instagram from your coin's settings at any time, or remove {app} in Instagram's settings under apps and
        websites. See <a href="/data-deletion">data deletion</a> to have your data removed.
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
      <p>To delete the Instagram data we hold for an account you connected:</p>
      <ol>
        <li>Open Instagram, go to Settings, then Apps and websites.</li>
        <li>Remove this app. We delete the stored access token and account details automatically.</li>
      </ol>
      <p>
        You can also disconnect Instagram from your coin's settings page. Coin data written to the blockchain and IPFS is public
        and can't be deleted by anyone.
      </p>
    </article>
  );
}
