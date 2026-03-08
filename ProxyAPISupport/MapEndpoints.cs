using System;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;
using EncryptedMessaging;
using Microsoft.AspNetCore.Http;

namespace ProxyAPISupport
{
    public static class MapEndpoints
    {
        /// <summary>
        /// End point for GET /proxyinfo
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
        public static async Task Status(HttpContext context)
        {
            if (context.Request.Query.TryGetValue("ping", out var _))
            {
                context.Response.StatusCode = StatusCodes.Status200OK;
                await context.Response.WriteAsync("ok");
            }
            else if (context.Request.Query.TryGetValue("qr", out var _))
            {
                string html = LoadClientHtml();
                await context.Response.WriteAsync(html);
            }
            else
            {
                Util.SetCurrentHost(context);
                await context.Response.WriteAsync(Util.Info);
            }
        }

        /// <summary>
        /// End point for GET /data
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
        public static async Task DataGet(HttpContext context)
        {
            if (context.Request.Query.TryGetValue("log", out var log))
            {
                log = HttpUtility.UrlDecode(log);
                context.Request.Query.TryGetValue("scope", out var scope);
                if (scope == "")
                    scope = "report";
                if (Regex.IsMatch(scope, @"^[a-zA-Z0-9_]+$")) // Only letters, numbers and underscore (for security)
                {
                    try
                    {
                        LogRepository ??= Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                        if (!Directory.Exists(LogRepository))
                            Directory.CreateDirectory(LogRepository);
                        var logFile = Path.Combine(LogRepository, scope + ".log");
                        File.AppendAllText(logFile, DateTime.UtcNow + Environment.NewLine + log + Environment.NewLine + (char)12 + Environment.NewLine);
                        context.Response.StatusCode = StatusCodes.Status200OK;
                    }
                    catch (Exception ex)
                    {
                        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                        Console.WriteLine(ex.Message);
                    }
                }
            }
            else if (context.Request.Query.TryGetValue("cid", out var cid))
            {
                var idBytes = cid[0].HexToBytes();
                var clientId = BitConverter.ToUInt64(idBytes, 0);
                if (Communication.GetPushNotification(clientId, out var pushNotification))
                {
                    await SetResponse(context, pushNotification);
                    return;
                }
            }
            else if (await Test(context))
            {
                return;
            }
            else
            {
                context.Response.StatusCode = StatusCodes.Status204NoContent;
            }
        }
        /// <summary>
        /// Path for logs: A remote machine can send logs to this proxy via http GET / log method, which will be saved in this directory
        /// </summary>
        public static string LogRepository { get; set; }

        private static string LoadClientHtml()
        {
            // Prefer local file so proxy serves the same web client currently under development.
            var baseDir = AppContext.BaseDirectory;
            var localCandidates = new[]
            {
                Path.Combine(baseDir, "ClientHtml", "CryptoCloudClientWeb.html"),
                Path.Combine(baseDir, "..", "ClientHtml", "CryptoCloudClientWeb.html"),
                Path.Combine(baseDir, "..", "..", "ClientHtml", "CryptoCloudClientWeb.html"),
                Path.Combine(baseDir, "..", "..", "..", "ClientHtml", "CryptoCloudClientWeb.html"),
                Path.Combine(baseDir, "..", "..", "..", "..", "ClientHtml", "CryptoCloudClientWeb.html"),
                Path.Combine(Directory.GetCurrentDirectory(), "ClientHtml", "CryptoCloudClientWeb.html"),
            };

            foreach (var candidate in localCandidates)
            {
                try
                {
                    var fullPath = Path.GetFullPath(candidate);
                    if (File.Exists(fullPath))
                        return File.ReadAllText(fullPath);
                }
                catch
                {
                    // Ignore and continue to next candidate.
                }
            }

            // Fallback for behavior when local file is not available.
            var browserUrl = "https://raw.githubusercontent.com/Andrea-Bruno/ProxyCloud/master/ClientHtml/CryptoCloudClientWeb.html";
            using var wc = new WebClient();
            return wc.DownloadString(browserUrl);
        }

        /// <summary>
        /// End point for POST /data
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>

        public static async Task DataPost(HttpContext context)
        {
            if (context.Request.Query.TryGetValue("cid", out var cid))
            {
                ulong? chatId;
                var purpose = Communication.Purpose.Forwarding;
                if (context.Request.Query.TryGetValue("purpose", out var purposeText))
                    _ = Enum.TryParse(purposeText, out purpose);
                var clientId = BitConverter.ToUInt64(cid[0].HexToBytes(), 0);
                if (context.Request.Query.TryGetValue("sid", out var sid)) // server Id (8 bit hash of server public key)
                {
                    var serverId = BitConverter.ToUInt64(sid[0].HexToBytes(), 0);
                    chatId = ContactConverter.UserIdsToChatId(new ulong[] { serverId, CommunicationServer.Context.My.Id });
                    // chatId = Communication.UserIdToChatId.GetCorrespondingId(serverId);
                }
                else
                {
                    chatId = Communication.ClientIdToChatId.GetCorrespondingId(clientId);
                }
                if (chatId == null)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                }
                else
                {
                    byte[] data = null;
                    if (context.Request.Query.TryGetValue("dt", out var dt))
                    {
                        var datab64 = dt[0];
                        data = Convert.FromBase64String(datab64);
                    }
                    else if (context.Request.ContentLength != null && context.Request.ContentLength > 0)
                    {
                        var dataLength = (int)context.Request.ContentLength;
                        data = new byte[dataLength];
                        var readed = 0;
                        do
                        {
                            var arRead = context.Request.Body.BeginRead(data, readed, dataLength - readed, null, null);
                            if (!arRead.AsyncWaitHandle.WaitOne(120000))
                            {
                                context.Response.StatusCode = StatusCodes.Status408RequestTimeout;
                                return;
                            }
                            readed += context.Request.Body.EndRead(arRead);
                        } while (readed < dataLength);
                    }
                    string ip = null;
                    string userAgent = null;
                    if (purpose == Communication.Purpose.SetClient)
                    {
                        ip = context.Request.Host.Host;
                        userAgent = context.Request.Headers["User-Agent"];
                    }
                    context.Response.StatusCode = Communication.RequestToDevice((ulong)chatId, clientId, purpose, data, out var response, ip, userAgent);
                    if (context.Response.StatusCode == StatusCodes.Status200OK)
                    {
                        await SetResponse(context, response);
                        return;
                    }
                }
            }
            else if (await Test(context))
            {
                return;
            }
            else
            {
                context.Response.StatusCode = StatusCodes.Status501NotImplemented;
            }
            await context.Response.WriteAsync(context.Response.StatusCode.ToString());
        }

        private static async Task<bool> Test(HttpContext context)
        {
            if (context.Request.Query.TryGetValue("test", out var test))
            {
                var response = new Communication.CommandForClient
                {
                    EncryptedData = test[0].HexToBytes()
                };
                await SetResponse(context, response);
                return true;
            }
            return false;
        }
        private static async Task SetResponse(HttpContext context, Communication.CommandForClient response)
        {
            //context.Response.StatusCode = StatusCodes.Status200OK;
            if (response != null && response.EncryptedData != null)
                await context.Response.Body.WriteAsync(Encoding.ASCII.GetBytes(Convert.ToBase64String(response.EncryptedData)));
        }

    }
}
