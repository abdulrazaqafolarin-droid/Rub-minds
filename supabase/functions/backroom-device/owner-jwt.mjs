/**
 * Resolve the owner exclusively from a Supabase-verified bearer access token.
 * The HTTP request body is deliberately never consulted for the owner identity.
 */
const BEARER=/^Bearer ([A-Za-z0-9_.-]{32,4096})$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {Request} request
 * @param {(accessToken:string)=>Promise<{data?:{user?:{id?:string}|null},error?:unknown}>} verifyUser
 * @returns {Promise<string|null>}
 */
export async function resolveOwnerFromJwt(request,verifyUser){
 if(!request?.headers||typeof request.headers.get!=='function')
  throw new TypeError('HTTP request required');
 if(typeof verifyUser!=='function')
  throw new TypeError('Supabase user verifier required');
 const match=BEARER.exec(request.headers.get('authorization')??'');
 if(!match)return null;
 const {data,error}=await verifyUser(match[1]);
 if(error||!UUID.test(data?.user?.id??''))return null;
 return data.user.id;
}
