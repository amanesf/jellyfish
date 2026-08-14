const sharp=require('sharp');
(async()=>{
const {data,info}=await sharp('1786664132447.png').raw().toBuffer({resolveWithObject:true});
const {width:W,height:H,channels:C}=info;
const px=(x,y)=>{const p=(y*W+x)*C;return [data[p],data[p+1],data[p+2]];};
for(const y of [700,250,1000]){
 let s='y='+y+': ';
 for(let x=0;x<W;x+=40){const c=px(x,y);s+=x+':'+c.join(',')+'  ';}
 console.log(s);
}
for(const x of [448,200]){let s='x='+x+': ';
 for(let y=0;y<H;y+=50){const c=px(x,y);s+=y+':'+c.join(',')+'  ';}console.log(s);}
})();
