import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Player commands match Spotifast methods, targets and body framing over HTTP',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rotation-player-wire-'));
  Object.assign(process.env,{SESSION_SECRET:'wire-test-secret-wire-test-secret-wire-test-secret',SPOTIFY_CLIENT_ID:'test',SPOTIFY_CLIENT_SECRET:'test',SPOTIFY_REDIRECT_URI:'http://127.0.0.1:3000/auth/callback',DATA_DIR:directory});
  const received=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    received.push({method:req.method,url:req.url,headers:req.headers,body});
    res.writeHead(200,{'Content-Type':'text/plain'});res.end('accepted');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(String(input));
    assert.equal(url.origin,'https://api.spotify.com');
    return nativeFetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,init);
  };
  try{
    const player=await import('../dist/spotify-player.js');
    const session={id:'wire-test',tokens:{access:'dummy',expiresAt:Date.now()+3600000},grantedScopes:['user-modify-playback-state']};
    const device='desk id?';
    const requests=[player.startContext(device,'spotify:playlist:SOURCE12345','spotify:track:ITEM1'),player.startTracks(device,['spotify:track:ITEM1','spotify:track:ITEM2']),player.resume(device),player.pause(device),player.next(device),player.previous(device),player.transfer(device,false)];
    for(const request of requests)await player.sendPlayerCommand(session,request,false);
    assert.equal(received.length,requests.length,'one outgoing command per action, no discovery/mode/queue reads');
    for(const [i,request] of requests.entries()){
      const actual=received[i];
      assert.equal(actual.method,request.method);
      assert.equal(actual.url,`/v1${request.path}`);
      assert.equal(actual.headers.authorization,'Bearer dummy');
      if(request.body){
        assert.deepEqual(JSON.parse(actual.body),request.body);
        assert.match(actual.headers['content-type'],/^application\/json/);
        assert.equal(Number(actual.headers['content-length']),Buffer.byteLength(actual.body));
      }else{
        assert.equal(actual.body,'');
        assert.equal(actual.headers['content-length'],'0');
        assert.equal(actual.headers['content-type'],undefined);
      }
    }
  }finally{
    globalThis.fetch=nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  }
});
