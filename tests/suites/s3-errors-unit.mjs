import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * S3 failures, said in Italian with their cause and their fix.
 *
 * The bodies below are the shapes the providers actually send. What is checked
 * is the part a person acts on — which problem it was recognised as, that the
 * sentence names the bucket or the region it is about — and the one thing that
 * must never happen: an error document's string-to-sign or access key id
 * reaching the text the panel shows and logs.
 */
export const meta = { name: "s3-errors-unit", needsDocker: false, drivers: [], standalone: true };

const xml = (code, message, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message>${extra}<RequestId>4442587FB7D0A2F9</RequestId></Error>`;

export async function run({ repoRoot }) {
  const r = createReporter("s3-errors-unit");
  const m = await import(pathToFileURL(join(repoRoot, "lib", "s3-errors.ts")).href);

  const ctx = { operation: "write-test", bucket: "runpanel-backups", region: "eu-central-1", endpoint: "https://s3.eu-central-1.amazonaws.com" };
  const said = (problem) => `${problem.cause} ${problem.fix}`;

  // --- answers with an error document ---------------------------------------
  {
    const p = m.describeS3Response({ status: 403, body: xml("InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.", "<AWSAccessKeyId>AKIAEXAMPLE</AWSAccessKeyId>") }, ctx);
    r.check("unknown access key", p.code === "InvalidAccessKeyId" && /access key ID non esiste/.test(p.cause), said(p));
    r.check("the access key id in the body is not repeated", !said(p).includes("AKIAEXAMPLE") && !(p.detail ?? "").includes("AKIAEXAMPLE"), p.detail);
  }
  {
    const p = m.describeS3Response(
      { status: 403, body: xml("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.", "<StringToSign>AWS4-HMAC-SHA256\n20261118T000000Z</StringToSign><CanonicalRequest>PUT /x</CanonicalRequest>") },
      ctx
    );
    r.check("wrong secret", p.code === "SignatureDoesNotMatch" && /secret access key/.test(p.cause), said(p));
    r.check("the string-to-sign never reaches the detail", !(p.detail ?? "").includes("AWS4-HMAC") && !(p.detail ?? "").includes("CanonicalRequest"), p.detail);
  }
  {
    const p = m.describeS3Response({ status: 404, body: xml("NoSuchBucket", "The specified bucket does not exist", "<BucketName>runpanel-backups</BucketName>") }, ctx);
    r.check("missing bucket names it", p.code === "NoSuchBucket" && p.cause.includes("«runpanel-backups»"), said(p));
  }
  {
    const p = m.describeS3Response({ status: 403, body: xml("AccessDenied", "Access Denied") }, ctx);
    r.check("access denied says what was being done", p.code === "AccessDenied" && p.cause.includes("scrivere"), said(p));
    r.check("and which permissions to grant", p.fix.includes("s3:PutObject"), p.fix);
    const reading = m.describeS3Response({ status: 403, body: xml("AccessDenied", "Access Denied") }, { ...ctx, operation: "download" });
    r.check("on a download it is reading", reading.cause.includes("leggere"), reading.cause);
  }
  {
    const p = m.describeS3Response(
      { status: 301, body: xml("PermanentRedirect", "The bucket you are attempting to access must be addressed using the specified endpoint.", "<Endpoint>runpanel-backups.s3.eu-west-1.amazonaws.com</Endpoint><Bucket>runpanel-backups</Bucket>") },
      ctx
    );
    r.check("a redirect is a wrong region, and says which", p.cause.includes("«eu-west-1»") && p.fix.includes("«eu-west-1»"), said(p));
  }
  {
    const p = m.describeS3Response(
      { status: 400, body: xml("AuthorizationHeaderMalformed", "The authorization header is malformed; the region 'eu-central-1' is wrong; expecting 'us-east-2'", "<Region>us-east-2</Region>") },
      ctx
    );
    r.check("a malformed header with a region is a wrong region", p.code === "AuthorizationHeaderMalformed" && p.fix.includes("us-east-2"), said(p));
  }
  {
    const p = m.parseS3Error(xml("AuthorizationHeaderMalformed", "the region 'us-east-1' is wrong; expecting 'eu-west-1'"));
    r.check("the expected region is read from the message too", p.region === "eu-west-1", JSON.stringify(p));
  }
  {
    const p = m.describeS3Response({ status: 403, body: xml("RequestTimeTooSkewed", "The difference between the request time and the current time is too large.") }, ctx);
    r.check("a skewed clock", p.code === "RequestTimeTooSkewed" && /orologio/.test(p.cause) && /ntp/i.test(p.fix), said(p));
  }
  {
    const p = m.describeS3Response({ status: 400, body: xml("EntityTooLarge", "Your proposed upload exceeds the maximum allowed size") }, { ...ctx, operation: "upload" });
    r.check("too large for one upload", p.code === "EntityTooLarge" && p.cause.includes("5 GB"), said(p));
  }
  {
    const p = m.describeS3Response({ status: 507, body: xml("XMinioStorageFull", "Storage backend has reached its minimum free drive threshold.") }, ctx);
    r.check("a full MinIO", p.code === "XMinioStorageFull" && /esaurito/.test(p.cause), said(p));
    const capped = m.describeS3Response({ status: 403, body: xml("AccessDenied", "Storage cap exceeded.") }, ctx);
    r.check("a storage cap under a generic code is not a permission problem", /esaurito/.test(capped.cause), said(capped));
    const words = m.describeS3Response({ status: 400, body: xml("SomethingElse", "storage cap exceeded") }, ctx);
    r.check("a storage cap said only in words", /esaurito/.test(words.cause), said(words));
  }
  {
    const p = m.describeS3Response({ status: 503, body: xml("SlowDown", "Please reduce your request rate.") }, ctx);
    r.check("throttling is temporary", p.code === "SlowDown" && /Riprova/.test(p.fix), said(p));
  }
  {
    const p = m.describeS3Response({ status: 400, body: xml("WeirdNewCode", "Something we never saw") }, ctx);
    r.check("an unknown code keeps the provider's words", p.code === "WeirdNewCode" && p.cause.includes("Something we never saw"), said(p));
    r.check("and the detail carries code and status", (p.detail ?? "").includes("WeirdNewCode") && (p.detail ?? "").includes("400"), p.detail);
  }

  // --- answers without a document --------------------------------------------
  {
    const p = m.describeS3Response({ status: 403, body: "" }, { ...ctx, operation: "stat" });
    r.check("a bare 403 is access denied, keys or permissions", p.code === "AccessDenied" && /access key, secret o permessi/.test(p.cause), said(p));
  }
  {
    const p = m.describeS3Response({ status: 404 }, { ...ctx, operation: "stat" });
    r.check("a bare 404 on an object is a missing archive", p.code === "NoSuchKey", p.code);
    const bucket = m.describeS3Response({ status: 404 }, ctx);
    r.check("a bare 404 on a write is a missing bucket", bucket.code === "NoSuchBucket", bucket.code);
  }
  {
    const p = m.describeS3Response({ status: 301, headers: { "x-amz-bucket-region": "eu-south-1" } }, { ...ctx, operation: "stat" });
    r.check("a HEAD redirect reads the region header", p.cause.includes("«eu-south-1»"), said(p));
    const viaGet = m.describeS3Response({ status: 301, headers: new Headers({ "X-Amz-Bucket-Region": "eu-south-1" }) }, { ...ctx, operation: "stat" });
    r.check("from a real Headers object too", viaGet.cause.includes("«eu-south-1»"), said(viaGet));
  }
  {
    const p = m.describeS3Response({ status: 200, body: "<!DOCTYPE html><html><body>Welcome to nginx</body></html>" }, ctx);
    r.check("an HTML page is not S3", p.code === "NotS3", p.code);
  }

  // --- no answer at all -------------------------------------------------------
  const fetchFailed = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
  const codeErr = (code, message = code) => Object.assign(new Error(message), { code });
  {
    const p = m.describeS3Exception(fetchFailed(codeErr("ENOTFOUND", "getaddrinfo ENOTFOUND runpanel-backups.s3.eu-central-1.amazonaws.com")), ctx);
    r.check("DNS failure", p.code === "DNS" && p.cause.includes("runpanel-backups.s3.eu-central-1.amazonaws.com"), said(p));
    r.check("virtual-hosted style suggests the path style", /nel percorso/.test(p.fix), p.fix);
    const path = m.describeS3Exception(fetchFailed(codeErr("ENOTFOUND")), { ...ctx, pathStyle: true, endpoint: "https://<account-id>.r2.cloudflarestorage.com" });
    r.check("path style names the endpoint host alone", !path.cause.includes("runpanel-backups."), path.cause);
  }
  {
    const p = m.describeS3Exception(fetchFailed(new AggregateError([codeErr("ECONNREFUSED"), codeErr("ECONNREFUSED")], "connect failed")), {
      ...ctx,
      endpoint: "http://192.168.1.10:9000",
      pathStyle: true,
    });
    r.check("refused, inside an AggregateError", p.code === "REFUSED" && p.cause.includes("192.168.1.10:9000"), said(p));
  }
  {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    r.check("a timeout", m.describeS3Exception(timeout, ctx).code === "TIMEOUT");
    r.check("a connect timeout", m.describeS3Exception(fetchFailed(codeErr("UND_ERR_CONNECT_TIMEOUT")), ctx).code === "TIMEOUT");
  }
  r.check("an expired certificate", m.describeS3Exception(fetchFailed(codeErr("CERT_HAS_EXPIRED")), ctx).code === "TLS_EXPIRED");
  r.check("a self-signed certificate", m.describeS3Exception(fetchFailed(codeErr("DEPTH_ZERO_SELF_SIGNED_CERT")), ctx).code === "TLS_UNTRUSTED");
  {
    const p = m.describeS3Exception(fetchFailed(codeErr("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames")), ctx);
    r.check("a certificate for another name", p.code === "TLS_NAME" && /nel percorso/.test(p.fix), said(p));
  }
  {
    const p = m.describeS3Exception(fetchFailed(codeErr("EPROTO", "write EPROTO 0C0A0000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number")), ctx);
    r.check("https towards an http port", p.code === "TLS_NOT_HTTPS", p.code);
  }
  {
    const p = m.describeS3Exception(fetchFailed(codeErr("ECONNRESET", "other side closed")), { ...ctx, operation: "upload" });
    r.check("a reset during an upload points at Verifica", p.code === "RESET" && /Verifica/.test(p.fix), said(p));
  }
  r.check("an unknown network error keeps its words", m.describeS3Exception(new Error("boom"), ctx).cause.includes("boom"));

  // --- the error the adapter throws ------------------------------------------
  {
    const problem = m.describeS3Response({ status: 403, body: xml("AccessDenied", "Access Denied") }, ctx);
    const failure = new m.S3Failure(problem);
    r.check("its message is the two sentences", failure.message === `${problem.cause} ${problem.fix}`);
    r.check("and it passes through unchanged", m.describeS3Exception(failure, ctx) === problem);
  }

  return r.result();
}
