using System;
using System.Collections.Generic;
using System.Net;
using System.Text;
using System.Threading;
using EncryptedMessaging;
using Microsoft.AspNetCore.Http;

namespace ProxyAPISupport
{
    public static class Communication
    {
        /// <summary>
        /// Purpose of the message (sending data via proxy, or other)
        /// </summary>
        public enum Purpose : ushort // 2 byte - the names must start with Get or Set
        {
            Forwarding,
            ForwardingWithEncryptRsa256,
            GetProxyAddress,
            /// <summary>
            /// Parameter used only for communication between browser and proxy to read any push messages sent by the device
            /// </summary>
            GetPushNotifications,
            /// <summary>
            /// Used to send the public key and setting from the browser/client to the device (server). Normally the public key must be scanned by the QR code in the client.
            /// The public key is not encrypted because the exchange of cryptographic keys has not yet taken place.
            /// </summary>
            SetClient,
            /// <summary>
            /// Implementation of the type 2 QR code, it is used to complete the QR code by sending part of it via proxy (in order to create a smaller QR code)
            /// </summary>
            GetEncryptedQR,
        }

        public static CommunicationServer Server { get; private set; }
        /// <summary>
        /// Start the proxy with encrypted protocols, which acts as a link between the clients and the cloud server. The proxy cannot see the data it transmits as the encryption is between client and server.
        /// </summary>
        /// <param name="privateKey">The key that identifies the proxy on the communications network connected to the router. Clouds to connect to the proxy must have the public key corresponding to this private key.</param>
        /// <param name="entryPoint">The web or IP address of the router (default id "localhost"). The proxy will attempt to connect to the router via this address. The value of default is localhost, in which case the proxy and the router must be running on the same hardware. If the router is remote, exposed to the Internet, it is advisable to use a third level domain as an entry point so as not to be bound to the router IP (if the router changes IP, just update the DNS record to get the proxy again. connected to it).</param>
        /// <param name="connectivity">If true, the proxy will try to connect to the router via the entry point. If false, it will not try to connect to the router. This parameter is ignored for pipe connection type</param>
        /// <returns>False if it has already been initialized, otherwise true</returns>
        public static bool Initialize(string privateKey, string entryPoint = null, bool? connectivity = null)
        {
            if (IsInitialized)
                return false;

            if (DefaultEntryLocalPoint == LocalEntryPoint.Pipe)
            {
                entryPoint ??= "pipe://router";
            }
            else
            {
                entryPoint ??= IPAddress.Loopback.ToString();
            }
            if (entryPoint.StartsWith("pipe:"))
                connectivity = true;
            Server = new CommunicationServer(privateKey, entryPoint, connectivity);
            IsInitialized = true;
            return true;
        }

        public static LocalEntryPoint DefaultEntryLocalPoint = LocalEntryPoint.LocalhostTcp;

        public enum LocalEntryPoint
        {
            Pipe,
            LocalhostTcp,
            LocalhostHttp,
        }

        public const int Port = 5050;
        public static bool IsInitialized { get; private set; }


        // internal static readonly PairedTable UserIdToChatId = new("UserIdToChatId");
        internal static readonly PairedTable ClientIdToChatId = new("ClientIdToChatId");

        /// <summary>
        /// Send commands from the web server to the device (SmartPhone, tablet, etc.)
        /// </summary>
        /// <param name="purpose">Purpose of the message (sending data via proxy, or other)</param>
        /// <param name="directlyWithoutSpooler"></param>
        /// <param name="encrypted"></param>
        /// <param name="values"></param>
        public static void SendCommand(Contact toContact, ulong fromClientId, Purpose purpose, bool directlyWithoutSpooler = false, bool encrypted = true, params byte[][] values)
        {
            var newValues = new byte[values.Length + 1][];
            Array.Copy(values, 0, newValues, 1, values.Length);
            newValues[0] = BitConverter.GetBytes(fromClientId);
            CommunicationServer.Context.Messaging.SendCommandToSubApplication(toContact, BitConverter.ToUInt16(Encoding.ASCII.GetBytes("proxy"), 0), (ushort)purpose, directlyWithoutSpooler, encrypted, newValues);
        }

        /// <summary>
        /// Send commands from the web server to the device (SmartPhone, tablet, etc.)
        /// </summary>
        /// <param name="purpose">Purpose of the message (sending data via proxy, or other)</param>
        /// <param name="directlyWithoutSpooler"></param>
        /// <param name="encrypted"></param>
        /// <param name="data"></param>
        public static void SendCommand(Contact toContact, ulong fromClientId, Purpose purpose, bool directlyWithoutSpooler = false, bool encrypted = true, byte[] data = null)
        {
            data ??= Array.Empty<byte>();
            CommunicationServer.Context.Messaging.SendCommandToSubApplication(toContact, BitConverter.ToUInt16(Encoding.ASCII.GetBytes("proxy"), 0), (ushort)purpose, directlyWithoutSpooler, encrypted, BitConverter.GetBytes(fromClientId), data);
        }

        public static void OnCommand(Contact contact, Purpose ResponseToPurpose, byte[] data, List<byte[]> parameters)
        {
            // All messages destined for the web application are in here
            switch (ResponseToPurpose)
            {
                case Purpose.GetProxyAddress:
                    var host = Util.CurrentHost;
                    string hostName = host == null ? "" : host.ToString();
                    SendCommand(contact, 0, ResponseToPurpose, true, true, Encoding.ASCII.GetBytes(hostName));
                    break;
                case Purpose.ForwardingWithEncryptRsa256: // Paired!
                                                          // we do the Pair with the hash of the public key to not let the server know anything about the keys used (amuento security and privacy)
                    if (contact.UserId != null)
                    {
                        var clientId = BitConverter.ToUInt64(parameters[0]);
                        data = parameters[1];
                        ClientIdToChatId.AddPair(clientId, contact.ChatId);
                    }
                    break;
            }
            var response = new CommandForClient
            {
                Purpose = ResponseToPurpose,
                EncryptedData = data,
            };
            if (contact.Session.TryGetValue("semaphore", out var semaphoreObject))
            {
                contact.Session.Remove("semaphore");
                contact.Session["response"] = response;
                var semaphore = semaphoreObject as SemaphoreSlim;
                if (semaphore.CurrentCount == 0)
                    semaphore.Release();
            }
            else if (contact.Session.TryGetValue("pushNotifications", out var pushNotificationsObject))
            {
                var pushNotifications = pushNotificationsObject as List<CommandForClient>;
                pushNotifications.Add(response);
            }
            else
            {
                var pushNotifications = new List<CommandForClient>();
                contact.Session["pushNotifications"] = pushNotifications;
                pushNotifications.Add(response);
            }
        }

        public static int RequestToDeviceCounter { get; private set; }
        public static int AnswerFromDeviceCounter { get; private set; }
        public static DateTime LastClientOverRequest { get; private set; }
        public static int MaxConcurrentRequestForUser { get; set; } = 4;
        public static DateTime LastRequestSaturation { get; private set; }
        public static int RequestConcurent { get; private set; }
        public static int MaxRequestConcurent { get; set; } = 100;
        internal static readonly Dictionary<ulong, int> ConcurrentRequestForUser = [];

        /// <summary>
        /// Send a command to the device 
        /// </summary>
        /// <param name="purpose">Purpose of the message (sending data via proxy, or other)</param>
        /// <param name="response">The response that the device (smartphone, tablet, etc.) gives to the command sent to it</param>
        /// <returns>True if the response arrives within the timeout, otherwise false</returns>
        public static int RequestToDevice(ulong chatId, ulong fromClientId, Purpose purpose, byte[] data, out CommandForClient response, string ip = null, string? userAgent = null)
        {
            RequestToDeviceCounter++;
            int statusCode = StatusCodes.Status200OK;
            response = null;
            var contact = CommunicationServer.Context.Contacts.GetContact(chatId);
            if (contact == null)
                return StatusCodes.Status421MisdirectedRequest;
            RequestConcurent++;
            try
            {
                if (RequestConcurent > MaxRequestConcurent)
                {
                    LastRequestSaturation = DateTime.UtcNow;
                    statusCode = StatusCodes.Status503ServiceUnavailable;
                }
                else
                {
                    lock (contact)
                    {
                        ConcurrentRequestForUser.TryGetValue(chatId, out var counterConcurentRequestForUser);
                        lock (ConcurrentRequestForUser)
                        {
                            counterConcurentRequestForUser++;
                            if (ConcurrentRequestForUser.ContainsKey(chatId))
                                ConcurrentRequestForUser.Remove(chatId);
                            ConcurrentRequestForUser.Add(chatId, counterConcurentRequestForUser);
                        }
                        if (counterConcurentRequestForUser > MaxConcurrentRequestForUser)
                        {
                            LastClientOverRequest = DateTime.UtcNow;
                            statusCode = StatusCodes.Status429TooManyRequests;
                        }
                        else
                        {
                            if (contact.Session.ContainsKey("response"))
                                contact.Session.Remove("response");
                            if (ip != null && userAgent != null)
                                SendCommand(contact, fromClientId, purpose, true, true, data, Encoding.ASCII.GetBytes(ip), Encoding.ASCII.GetBytes(userAgent));
                            else
                                SendCommand(contact, fromClientId, purpose, true, true, data);
                            if (contact.Session.ContainsKey("semaphore"))
                                contact.Session.Remove("semaphore");
                            var semaphore = new SemaphoreSlim(0, 1);
                            contact.Session.Add("semaphore", semaphore);
                            var limitMbps = 0.01; // minimun neetwork speed
                            var mb = (data == null ? 0 : data.Length) / (double)1000000;
                            var sec = mb / limitMbps;
                            semaphore.Wait(30000 + Convert.ToInt32(sec * 1000)); // Wait for a response with a timeout of 10000 ms + time the time it takes to send data at the limitMbps
                            if (contact.Session.TryGetValue("response", out var responseObject))
                            {
                                AnswerFromDeviceCounter++;
                                response = (CommandForClient)responseObject;
                                if (response == null)
                                    statusCode = StatusCodes.Status500InternalServerError;
                                else
                                {
                                    contact.Session.Remove("response");
                                    statusCode = StatusCodes.Status200OK;
                                }
                            }
                            else
                                statusCode = StatusCodes.Status504GatewayTimeout; // Cloud is of or not connected
                        }
                    }
                    lock (ConcurrentRequestForUser)
                    {
                        ConcurrentRequestForUser.TryGetValue(chatId, out var counterConcurentRequestForUser);
                        counterConcurentRequestForUser--;
                        if (ConcurrentRequestForUser.ContainsKey(chatId))
                            ConcurrentRequestForUser.Remove(chatId);
                        ConcurrentRequestForUser.Add(chatId, counterConcurentRequestForUser);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine(ex.ToString());
            }
            RequestConcurent--;
            return statusCode;
        }

        public static bool GetPushNotification(ulong clientId, out CommandForClient? pushNotification)
        {
            var chatId = ClientIdToChatId.GetCorrespondingId(clientId);
            if (chatId != null)
            {
                var contact = CommunicationServer.Context.Contacts.GetContact((ulong)chatId);
                if (contact != null && contact.Session.TryGetValue("pushNotifications", out var pushNotificationsObject))
                {
                    var pushNotifications = pushNotificationsObject as List<CommandForClient>;
                    lock (pushNotifications)
                    {
                        if (pushNotifications.Count > 0)
                        {
                            pushNotification = pushNotifications[0];
                            pushNotifications.Remove(pushNotification);
                            return true;
                        }
                    }
                }
            }
            pushNotification = null;
            return false;
        }
        /// <summary>
        /// It is a command intended for the client (the browser). The command could be either received as a response to a client request, or sent by the device as an action to be performed in the browser with a push notification.
        /// </summary>
        public class CommandForClient
        {
            /// <summary>
            /// Purpose of the message (sending data via proxy, or other)
            /// </summary>
            public Purpose Purpose;
            /// <summary>
            /// Encrypted data that is part of the command. Once decrypted the data contains a command for the client (browser) and parameters that vary according to the command
            /// </summary>
            public byte[] EncryptedData;
        }

    }

}
